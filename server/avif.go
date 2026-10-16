package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Photos and pictures (JPEG, PNG) also get an AVIF copy next to them, about
// a tenth of the size, made in the background after the upload by libavif's
// avifenc (apt install libavif-bin). Apps and browsers that show AVIF say so
// in their Accept header and get the copy; the rest (Safari before iOS/iPadOS
// 16) get the original, which is always kept. Without avifenc nothing is
// converted and everyone gets the original.

const (
	avifMaxBytes  = 20 << 20
	avifMaxPixels = 4096 * 4096
)

var (
	avifQueue = make(chan string, 512)
	avifenc   string // its path; empty when it isn't installed
)

func avifName(name string) string { return strings.TrimSuffix(name, filepath.Ext(name)) + ".avif" }

func avifSource(ext string) bool { return ext == ".jpg" || ext == ".jpeg" || ext == ".png" }

// queueAVIF asks for an AVIF copy of a fresh upload; when the queue is full
// it's left to the next start's catch-up.
func queueAVIF(name string) {
	if avifenc != "" && avifSource(filepath.Ext(name)) {
		select {
		case avifQueue <- name:
		default:
		}
	}
}

// avifWorker makes the copies, one at a time, for the life of the server.
// It starts by catching up on pictures that have none yet.
func (s *Server) avifWorker() {
	path, err := exec.LookPath("avifenc")
	if err != nil {
		log.Printf("avif: avifenc isn't installed (apt install libavif-bin); pictures are sent as they are")
		return
	}
	avifenc = path
	go func() {
		entries, _ := os.ReadDir(s.uploadDir())
		for _, e := range entries {
			name := e.Name()
			if uploadNameRe.MatchString(name) && avifSource(filepath.Ext(name)) && !fileExists(filepath.Join(s.uploadDir(), avifName(name))) {
				avifQueue <- name
			}
		}
	}()
	for name := range avifQueue {
		s.makeAVIF(name)
	}
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func (s *Server) makeAVIF(name string) {
	dir := s.uploadDir()
	src, dst := filepath.Join(dir, name), filepath.Join(dir, avifName(name))
	if fileExists(dst) {
		return
	}
	data, err := os.ReadFile(src)
	if err != nil || len(data) > avifMaxBytes {
		return
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width*cfg.Height > avifMaxPixels || !stillAndUpright(data, format) {
		return
	}
	// Quality 70 looks the same as the original; 4:4:4 keeps coloured text in
	// screenshots crisp. avifenc carries the colour profile over. One thread,
	// so other apps on the server don't feel it.
	yuv := "420"
	if format == "png" {
		yuv = "444"
	}
	tmp := strings.TrimSuffix(dst, ".avif") + ".part.avif" // not an upload name: never served or cleaned up
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	start := time.Now()
	out, err := exec.CommandContext(ctx, avifenc, "-q", "70", "-s", "8", "-j", "1", "-y", yuv, src, tmp).CombinedOutput()
	if err != nil {
		os.Remove(tmp)
		log.Printf("avif: %s: %v: %s", name, err, strings.TrimSpace(string(out)))
		return
	}
	st, err := os.Stat(tmp)
	if err != nil || st.Size() >= int64(len(data))*9/10 {
		os.Remove(tmp) // not worth a copy
		return
	}
	if err := os.Rename(tmp, dst); err != nil {
		os.Remove(tmp)
		return
	}
	log.Printf("avif: %s %d KB → %d KB in %v", name, len(data)>>10, st.Size()>>10, time.Since(start).Round(time.Millisecond))
}

// serveAVIF sends the AVIF copy of a picture to clients that show AVIF and
// reports whether it did. Downloads (?name=) always get the original.
func serveAVIF(w http.ResponseWriter, r *http.Request, dir, name string) bool {
	if !avifSource(filepath.Ext(name)) {
		return false
	}
	w.Header().Set("Vary", "Accept")
	if r.URL.Query().Get("name") != "" || !strings.Contains(r.Header.Get("Accept"), "image/avif") {
		return false
	}
	f, err := os.Open(filepath.Join(dir, avifName(name)))
	if err != nil {
		// Not made yet (it takes a moment): ask again soon, so this client
		// doesn't keep the larger original for good.
		if st, err := os.Stat(filepath.Join(dir, name)); err == nil && avifenc != "" && time.Since(st.ModTime()) < 10*time.Minute {
			w.Header().Set("Cache-Control", "public, max-age=60")
		}
		return false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return false
	}
	w.Header().Set("Content-Type", "image/avif")
	http.ServeContent(w, r, avifName(name), st.ModTime(), f)
	return true
}

// stillAndUpright: not an animated PNG (the copy would keep one frame) and
// not a JPEG that only its EXIF orientation turns upright.
func stillAndUpright(data []byte, format string) bool {
	switch format {
	case "jpeg":
		return jpegOrientation(data) <= 1
	case "png":
		return !pngAnimated(data)
	}
	return false
}

// jpegOrientation reads a JPEG's EXIF orientation: 0 if none, 1 if upright.
func jpegOrientation(b []byte) int {
	if len(b) < 4 || b[0] != 0xFF || b[1] != 0xD8 {
		return 0
	}
	for i := 2; i+4 <= len(b); {
		if b[i] != 0xFF {
			break
		}
		marker := b[i+1]
		if marker == 0xFF {
			i++ // fill byte
			continue
		}
		if marker == 0xDA || marker == 0xD9 {
			break // the image data: no more metadata
		}
		size := int(b[i+2])<<8 | int(b[i+3])
		end := i + 2 + size
		if size < 2 || end > len(b) {
			break
		}
		if seg := b[i+4 : end]; marker == 0xE1 && bytes.HasPrefix(seg, []byte("Exif\x00\x00")) {
			return exifOrientation(seg[6:]) // the first EXIF block counts
		}
		i = end
	}
	return 0
}

func exifOrientation(t []byte) int {
	if len(t) < 8 {
		return 0
	}
	var bo binary.ByteOrder
	switch string(t[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return 0
	}
	off := int(bo.Uint32(t[4:8]))
	if off < 8 || off+2 > len(t) {
		return 0
	}
	for k, n := 0, int(bo.Uint16(t[off:])); k < n; k++ {
		e := off + 2 + 12*k
		if e+12 > len(t) {
			return 0
		}
		if bo.Uint16(t[e:]) == 0x0112 {
			return int(bo.Uint16(t[e+8:]))
		}
	}
	return 0
}

// pngAnimated: an APNG says so (acTL) before its image data.
func pngAnimated(b []byte) bool {
	if len(b) < 8 || string(b[1:4]) != "PNG" {
		return false
	}
	for i := 8; i+8 <= len(b); {
		size := int(binary.BigEndian.Uint32(b[i:]))
		switch string(b[i+4 : i+8]) {
		case "acTL":
			return true
		case "IDAT":
			return false
		}
		if size < 0 || i+12+size > len(b) {
			return false
		}
		i += 12 + size
	}
	return false
}
