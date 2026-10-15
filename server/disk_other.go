//go:build !linux && !darwin

package main

func diskSpace(path string) (free, total uint64, ok bool) { return 0, 0, false }
