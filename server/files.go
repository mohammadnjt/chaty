package main

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"
)

// Files people upload live in files/uploads. Once a day the ones nothing
// points at anymore are removed: uploads that were never sent, photos people
// and groups replaced, photos of deleted accounts. Files of messages deleted
// for everyone stay (admins still see those messages). A day's grace keeps
// an upload whose message is still on its way.

const uploadGrace = 24 * time.Hour

type cleanupResult struct {
	At      int64 `json:"at"`
	Removed int   `json:"removed"`
	Bytes   int64 `json:"bytes"`
}

var lastCleanup atomic.Pointer[cleanupResult]

// cleanUploadsDaily runs for the life of the server.
func (s *Server) cleanUploadsDaily() {
	time.Sleep(10 * time.Minute)
	for {
		s.cleanUploads()
		time.Sleep(24 * time.Hour)
	}
}

func (s *Server) cleanUploads() {
	dir := s.uploadDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			log.Printf("uploads: cleanup: %v", err)
		}
		return
	}
	used := s.store.UploadsInUse()
	if len(used) == 0 && len(entries) > 0 {
		// Never wipe the folder because the data looks empty.
		log.Printf("uploads: nothing refers to any of %d files; leaving them", len(entries))
		return
	}
	res := cleanupResult{At: nowMs()}
	cutoff := time.Now().Add(-uploadGrace)
	for _, e := range entries {
		name := e.Name()
		if !e.Type().IsRegular() || !uploadNameRe.MatchString(name) || used[name] {
			continue
		}
		info, err := e.Info()
		if err != nil || info.ModTime().After(cutoff) {
			continue
		}
		if err := os.Remove(filepath.Join(dir, name)); err != nil {
			log.Printf("uploads: cleanup: %v", err)
			continue
		}
		res.Removed++
		res.Bytes += info.Size()
	}
	lastCleanup.Store(&res)
	log.Printf("uploads: removed %d unused file(s), %.1f MB", res.Removed, float64(res.Bytes)/(1<<20))
}

// uploadsUsage counts the uploaded files and their size.
func (s *Server) uploadsUsage() (count int, bytes int64) {
	entries, _ := os.ReadDir(s.uploadDir())
	for _, e := range entries {
		if info, err := e.Info(); err == nil && info.Mode().IsRegular() {
			count++
			bytes += info.Size()
		}
	}
	return count, bytes
}

// backupStatus is what scripts/backup.sh writes to files/backup.json after each run.
type backupStatus struct {
	At     int64  `json:"at"`
	OK     bool   `json:"ok"`
	Error  string `json:"error"`
	Remote string `json:"remote"`
}

func (s *Server) lastBackup() *backupStatus {
	b, err := os.ReadFile(filepath.Join(s.cfg.DataDir, "backup.json"))
	if err != nil {
		return nil
	}
	var st backupStatus
	if json.Unmarshal(b, &st) != nil || st.At == 0 {
		return nil
	}
	st.Error = strings.TrimSpace(st.Error)
	return &st
}

// filesOverview is the admin panel's Files card: uploads, disk, cleanup, backup.
func (s *Server) filesOverview() map[string]any {
	count, bytes := s.uploadsUsage()
	out := map[string]any{"count": count, "bytes": bytes, "cleanup": lastCleanup.Load(), "backup": s.lastBackup()}
	if free, total, ok := diskSpace(s.cfg.DataDir); ok {
		out["diskFree"], out["diskTotal"] = free, total
	}
	return out
}
