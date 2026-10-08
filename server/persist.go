package main

import (
	"bufio"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"
)

// All state lives in memory (see store.go); a Persister makes it durable.
// Records are (kind, id) -> JSON, so every backend stores the same thing and
// data can be moved between backends without conversion.

type record struct {
	Kind string          `json:"k"`
	ID   string          `json:"i"`
	Data json.RawMessage `json:"v,omitempty"` // nil means deleted
}

type Persister interface {
	// Load calls fn for every stored record, in write order where that matters.
	Load(fn func(r record)) error
	Apply(batch []record) error
	// Replace swaps the whole dataset atomically (compaction, migration).
	Replace(all []record) error
	Close() error
	Describe() string
}

func openPersister(st StorageSettings, dataDir string) (Persister, error) {
	switch st.Driver {
	case "", "file":
		return openFilePersister(filepath.Join(dataDir, "data", "chaty.jsonl"))
	case "sqlite", "postgres", "mysql":
		return openSQLPersister(st.Driver, st.DSN, dataDir)
	}
	return nil, fmt.Errorf("unknown storage driver %q", st.Driver)
}

// ---------- JSON Lines file (default) ----------

// filePersister appends one JSON object per line. Appends never rewrite old
// data, a torn last line (power cut) is simply skipped on load, and the file
// is compacted by writing a fresh copy and renaming it into place.
type filePersister struct {
	path     string
	f        *os.File
	w        *bufio.Writer
	lines    int
	lastSync time.Time
}

func openFilePersister(path string) (*filePersister, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	p := &filePersister{path: path}
	return p, p.reopen()
}

func (p *filePersister) reopen() error {
	f, err := os.OpenFile(p.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	p.f = f
	p.w = bufio.NewWriterSize(f, 64<<10)
	return nil
}

func (p *filePersister) Describe() string { return "file " + p.path }

func (p *filePersister) Load(fn func(r record)) error {
	f, err := os.Open(p.path)
	if err != nil {
		return err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 64<<20)
	bad := 0
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var r record
		if err := json.Unmarshal(line, &r); err != nil || r.Kind == "" {
			bad++
			continue
		}
		p.lines++
		fn(r)
	}
	if bad > 0 {
		log.Printf("storage: skipped %d unreadable line(s) in %s", bad, p.path)
	}
	return sc.Err()
}

func (p *filePersister) Apply(batch []record) error {
	for _, r := range batch {
		b, err := json.Marshal(r)
		if err != nil {
			return err
		}
		p.w.Write(b)
		p.w.WriteByte('\n')
		p.lines++
	}
	if err := p.w.Flush(); err != nil {
		return err
	}
	// The OS has the data after Flush; fsync at most once a second for power loss.
	if time.Since(p.lastSync) > time.Second {
		p.lastSync = time.Now()
		return p.f.Sync()
	}
	return nil
}

func (p *filePersister) Replace(all []record) error {
	tmp := p.path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	w := bufio.NewWriterSize(f, 1<<20)
	for _, r := range all {
		b, _ := json.Marshal(r)
		w.Write(b)
		w.WriteByte('\n')
	}
	if err := w.Flush(); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	f.Close()
	p.w.Flush()
	p.f.Close()
	if err := os.Rename(tmp, p.path); err != nil {
		p.reopen()
		return err
	}
	p.lines = len(all)
	return p.reopen()
}

func (p *filePersister) Close() error {
	p.w.Flush()
	p.f.Sync()
	return p.f.Close()
}

// ---------- SQL databases ----------

type sqlPersister struct {
	db     *sql.DB
	driver string
	label  string
}

func sqlDSN(driver, dsn, dataDir string) (sqlDriver, conn, label string, err error) {
	dsn = strings.TrimSpace(dsn)
	switch driver {
	case "sqlite":
		path := strings.TrimPrefix(strings.TrimPrefix(dsn, "sqlite://"), "sqlite:")
		if path == "" {
			path = filepath.Join(dataDir, "data", "chaty.db")
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return "", "", "", err
		}
		return "sqlite", "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)", "sqlite " + path, nil
	case "postgres":
		if dsn == "" {
			return "", "", "", errors.New("enter a PostgreSQL address, e.g. postgres://user:pass@host:5432/chaty")
		}
		return "pgx", dsn, "postgres " + redact(dsn), nil
	case "mysql":
		if dsn == "" {
			return "", "", "", errors.New("enter a MySQL address, e.g. mysql://user:pass@host:3306/chaty")
		}
		if strings.HasPrefix(dsn, "mysql://") {
			u, err := url.Parse(dsn)
			if err != nil {
				return "", "", "", err
			}
			c := mysql.NewConfig()
			c.User = u.User.Username()
			c.Passwd, _ = u.User.Password()
			c.Net = "tcp"
			c.Addr = u.Host
			if !strings.Contains(c.Addr, ":") {
				c.Addr += ":3306"
			}
			c.DBName = strings.TrimPrefix(u.Path, "/")
			c.Params = map[string]string{}
			for k, v := range u.Query() {
				c.Params[k] = v[0]
			}
			return "mysql", c.FormatDSN(), "mysql " + redact(dsn), nil
		}
		return "mysql", dsn, "mysql", nil
	}
	return "", "", "", fmt.Errorf("unknown driver %q", driver)
}

func redact(dsn string) string {
	if u, err := url.Parse(dsn); err == nil && u.User != nil {
		u.User = url.User(u.User.Username())
		return u.String()
	}
	return dsn
}

func openSQLPersister(driver, dsn, dataDir string) (*sqlPersister, error) {
	sqlDriver, conn, label, err := sqlDSN(driver, dsn, dataDir)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open(sqlDriver, conn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	db.SetConnMaxIdleTime(5 * time.Minute)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("can't connect: %w", err)
	}
	ddl := `CREATE TABLE IF NOT EXISTS chaty_records (kind VARCHAR(32) NOT NULL, id VARCHAR(191) NOT NULL, data TEXT NOT NULL, PRIMARY KEY (kind, id))`
	if driver == "mysql" {
		ddl = `CREATE TABLE IF NOT EXISTS chaty_records (kind VARCHAR(32) NOT NULL, id VARCHAR(191) NOT NULL, data MEDIUMTEXT NOT NULL, PRIMARY KEY (kind, id)) CHARACTER SET utf8mb4`
	}
	if _, err := db.Exec(ddl); err != nil {
		db.Close()
		return nil, err
	}
	return &sqlPersister{db: db, driver: driver, label: label}, nil
}

func (p *sqlPersister) Describe() string { return p.label }

func (p *sqlPersister) q(s string) string {
	if p.driver != "postgres" {
		return s
	}
	// Rewrite ? placeholders as $1, $2, …
	var b strings.Builder
	n := 0
	for _, ch := range s {
		if ch == '?' {
			n++
			fmt.Fprintf(&b, "$%d", n)
			continue
		}
		b.WriteRune(ch)
	}
	return b.String()
}

func (p *sqlPersister) upsertSQL() string {
	if p.driver == "mysql" {
		return `INSERT INTO chaty_records (kind, id, data) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)`
	}
	return p.q(`INSERT INTO chaty_records (kind, id, data) VALUES (?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET data = excluded.data`)
}

func (p *sqlPersister) Load(fn func(r record)) error {
	rows, err := p.db.Query(`SELECT kind, id, data FROM chaty_records`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var r record
		var data string
		if err := rows.Scan(&r.Kind, &r.ID, &data); err != nil {
			return err
		}
		r.Data = json.RawMessage(data)
		fn(r)
	}
	return rows.Err()
}

func (p *sqlPersister) write(tx *sql.Tx, batch []record) error {
	up, err := tx.Prepare(p.upsertSQL())
	if err != nil {
		return err
	}
	defer up.Close()
	del, err := tx.Prepare(p.q(`DELETE FROM chaty_records WHERE kind = ? AND id = ?`))
	if err != nil {
		return err
	}
	defer del.Close()
	for _, r := range batch {
		if r.Data == nil {
			_, err = del.Exec(r.Kind, r.ID)
		} else {
			_, err = up.Exec(r.Kind, r.ID, string(r.Data))
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func (p *sqlPersister) Apply(batch []record) error {
	tx, err := p.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := p.write(tx, batch); err != nil {
		return err
	}
	return tx.Commit()
}

func (p *sqlPersister) Replace(all []record) error {
	tx, err := p.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM chaty_records`); err != nil {
		return err
	}
	if err := p.write(tx, all); err != nil {
		return err
	}
	return tx.Commit()
}

func (p *sqlPersister) Close() error { return p.db.Close() }

// ---------- ordered async writer ----------

type writeOp struct {
	rec     record
	replace []record      // compaction / migration snapshot
	swap    Persister     // switch to another backend after this point
	done    chan struct{} // closed once everything before it is written
}

// writer applies changes in order on one goroutine, batching bursts, and
// retries forever on errors: nothing is dropped while a database is down.
type writer struct {
	p       Persister
	ops     chan writeOp
	mu      sync.Mutex
	lastErr string
	stopped chan struct{}
}

func newWriter(p Persister) *writer {
	w := &writer{p: p, ops: make(chan writeOp, 8192), stopped: make(chan struct{})}
	go w.loop()
	return w
}

func (w *writer) setErr(err error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if err == nil {
		w.lastErr = ""
	} else {
		w.lastErr = err.Error()
	}
}

func (w *writer) Status() (string, string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.current().Describe(), w.lastErr
}

func (w *writer) current() Persister { return w.p }

func (w *writer) retry(what string, fn func() error) {
	for delay := 200 * time.Millisecond; ; delay = min(delay*2, 10*time.Second) {
		err := fn()
		w.setErr(err)
		if err == nil {
			return
		}
		log.Printf("storage: %s failed, retrying in %s: %v", what, delay, err)
		time.Sleep(delay)
	}
}

func (w *writer) loop() {
	defer close(w.stopped)
	batch := make([]record, 0, 256)
	flush := func() {
		if len(batch) > 0 {
			w.retry("write", func() error { return w.p.Apply(batch) })
			batch = batch[:0]
		}
	}
	for op := range w.ops {
		switch {
		case op.replace != nil:
			flush()
			w.retry("compact", func() error { return w.p.Replace(op.replace) })
		case op.swap != nil:
			flush()
			old := w.p
			w.mu.Lock()
			w.p = op.swap
			w.mu.Unlock()
			old.Close()
		case op.done != nil:
			flush()
			close(op.done)
			continue
		default:
			batch = append(batch, op.rec)
			if len(batch) < cap(batch) && len(w.ops) > 0 {
				continue // keep batching while more is queued
			}
		}
		flush()
	}
	flush()
	w.p.Close()
}

func (w *writer) put(kind, id string, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		log.Printf("storage: marshal %s/%s: %v", kind, id, err)
		return
	}
	w.ops <- writeOp{rec: record{Kind: kind, ID: id, Data: b}}
}

func (w *writer) del(kind, id string) {
	w.ops <- writeOp{rec: record{Kind: kind, ID: id}}
}

func (w *writer) Sync() {
	done := make(chan struct{})
	w.ops <- writeOp{done: done}
	<-done
}

func (w *writer) Close() {
	close(w.ops)
	<-w.stopped
}
