//go:build linux || darwin

package main

import "syscall"

// diskSpace reports the free and total bytes of the disk holding path.
func diskSpace(path string) (free, total uint64, ok bool) {
	var st syscall.Statfs_t
	if syscall.Statfs(path, &st) != nil {
		return 0, 0, false
	}
	bs := uint64(st.Bsize)
	return st.Bavail * bs, st.Blocks * bs, true
}
