// Command goassets builds the Go toolchain that runs inside the browser:
// cmd/compile and cmd/link built for GOOS=js, the precompiled stdlib
// archives they compile and link against, and a small go/format module for
// the editor.
//
// Every asset is gzipped and named by its content hash under public/go/, and
// src/generated/go-manifest.json tells the app where each one is. The app
// decompresses with DecompressionStream, so it does not depend on the host
// compressing .wasm responses.
package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
)

// basePackages are needed by every build: testing and testdeps by the
// generated test main, the rest by the runtime itself.
var basePackages = []string{"os", "runtime", "testing", "testing/internal/testdeps"}

// extraPackages are not imported by any exercise today, but a learner
// reaching for one should not hit "could not import".
var extraPackages = []string{
	"bufio", "cmp", "container/ring", "crypto/md5", "crypto/sha256",
	"encoding/binary", "encoding/hex", "encoding/json", "hash/crc32",
	"hash/maphash", "io/fs", "iter", "log/slog", "maps", "math", "math/big",
	"math/rand/v2", "net/url", "path", "path/filepath", "regexp",
	"runtime/debug", "slices", "sort", "text/tabwriter", "text/template",
	"unicode", "unicode/utf8",
}

type asset struct {
	URL   string `json:"url"`
	Bytes int    `json:"bytes"` // compressed size, for download progress
}

type manifest struct {
	GoVersion string           `json:"goVersion"`
	Assets    map[string]asset `json:"assets"`
	Packages  []string         `json:"packages"`
	Stamp     string           `json:"stamp"`
}

type index struct {
	GoVersion string   `json:"goVersion"`
	Imports   []string `json:"imports"`
}

func main() {
	indexPath := flag.String("index", "src/generated/exercises.json", "exercise index written by gen")
	outDir := flag.String("out", "public/go", "asset output directory")
	manifestPath := flag.String("manifest", "src/generated/go-manifest.json", "manifest output path")
	wasmExecOut := flag.String("wasm-exec", "src/generated/wasm_exec.js", "where to copy wasm_exec.js")
	force := flag.Bool("force", false, "rebuild even if the stamp matches")
	flag.Parse()

	if err := run(*indexPath, *outDir, *manifestPath, *wasmExecOut, *force); err != nil {
		log.Fatalf("goassets: %v", err)
	}
}

func run(indexPath, outDir, manifestPath, wasmExecOut string, force bool) error {
	var idx index
	if err := readJSON(indexPath, &idx); err != nil {
		return fmt.Errorf("%w (run gen first)", err)
	}

	// The archives, the compiler and the linker must all come from one
	// toolchain, and it must be the one the exercises pin in go.mod.
	goVersion, err := goEnv("GOVERSION")
	if err != nil {
		return err
	}
	if goVersion != "go"+idx.GoVersion {
		return fmt.Errorf("found %s, but the exercises pin go%s: build with that version", goVersion, idx.GoVersion)
	}
	goroot, err := goEnv("GOROOT")
	if err != nil {
		return err
	}

	pkgs := slices.Concat(basePackages, extraPackages)
	for _, p := range idx.Imports {
		// Only the standard library can be precompiled; its first path
		// element never has a dot.
		if !strings.Contains(strings.Split(p, "/")[0], ".") {
			pkgs = append(pkgs, p)
		}
	}
	slices.Sort(pkgs)
	pkgs = slices.Compact(pkgs)

	gofmtSrc, err := os.ReadFile("tools/gofmt/main.go")
	if err != nil {
		return err
	}
	stampSum := sha256.Sum256([]byte(goVersion + "\n" + strings.Join(pkgs, "\n") + "\n" + string(gofmtSrc)))
	stamp := hex.EncodeToString(stampSum[:])

	var old manifest
	if !force && readJSON(manifestPath, &old) == nil && old.Stamp == stamp && assetsExist(old) {
		log.Printf("goassets: %s toolchain is up to date", goVersion)
		return copyFile(filepath.Join(goroot, "lib", "wasm", "wasm_exec.js"), wasmExecOut)
	}

	tmp, err := os.MkdirTemp("", "goassets-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)

	log.Printf("goassets: building %s compiler, linker and gofmt for js/wasm", goVersion)
	builds := map[string]string{"compile": "cmd/compile", "link": "cmd/link", "gofmt": "./tools/gofmt"}
	raw := map[string][]byte{}
	for name, pkg := range builds {
		out := filepath.Join(tmp, name+".wasm")
		if err := goJS("build", "-trimpath", "-ldflags=-s -w", "-o", out, pkg); err != nil {
			return err
		}
		if raw[name], err = os.ReadFile(out); err != nil {
			return err
		}
	}

	log.Printf("goassets: building %d stdlib packages for js/wasm", len(pkgs))
	raw["stdlib"], err = stdlibBundle(pkgs)
	if err != nil {
		return err
	}

	if err := os.RemoveAll(outDir); err != nil {
		return err
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return err
	}
	m := manifest{GoVersion: idx.GoVersion, Assets: map[string]asset{}, Packages: pkgs, Stamp: stamp}
	for name, b := range raw {
		gz, err := gzipBytes(b)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(gz)
		file := fmt.Sprintf("%s.%s.gz", name, hex.EncodeToString(sum[:])[:10])
		if err := os.WriteFile(filepath.Join(outDir, file), gz, 0o644); err != nil {
			return err
		}
		m.Assets[name] = asset{URL: "/go/" + file, Bytes: len(gz)}
		log.Printf("goassets: %-8s %6.1f MB -> %5.1f MB gzipped", name, mb(len(b)), mb(len(gz)))
	}

	if err := copyFile(filepath.Join(goroot, "lib", "wasm", "wasm_exec.js"), wasmExecOut); err != nil {
		return err
	}
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(manifestPath, append(b, '\n'), 0o644)
}

// stdlibBundle packs the compiled archive of every package in pkgs and their
// dependencies into one blob:
//
//	"GOPKGS1\n" | uint32 LE header length | header JSON | archive bytes...
//
// The header is [{"path": importPath, "size": n}, ...] in archive order.
func stdlibBundle(pkgs []string) ([]byte, error) {
	args := append([]string{"list", "-export", "-deps", "-f", "{{if .Export}}{{.ImportPath}}={{.Export}}{{end}}"}, pkgs...)
	out, err := goJSOutput(args...)
	if err != nil {
		return nil, err
	}

	type entry struct {
		Path string `json:"path"`
		Size int    `json:"size"`
	}
	var header []entry
	var data bytes.Buffer
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		importPath, file, ok := strings.Cut(line, "=")
		if !ok {
			return nil, fmt.Errorf("unexpected go list line %q", line)
		}
		b, err := os.ReadFile(file)
		if err != nil {
			return nil, err
		}
		header = append(header, entry{Path: importPath, Size: len(b)})
		data.Write(b)
	}

	h, err := json.Marshal(header)
	if err != nil {
		return nil, err
	}
	var bundle bytes.Buffer
	bundle.WriteString("GOPKGS1\n")
	binary.Write(&bundle, binary.LittleEndian, uint32(len(h)))
	bundle.Write(h)
	bundle.Write(data.Bytes())
	return bundle.Bytes(), nil
}

func goJS(args ...string) error {
	_, err := goJSOutput(args...)
	return err
}

func goJSOutput(args ...string) (string, error) {
	cmd := exec.Command("go", args...)
	cmd.Env = append(os.Environ(), "GOOS=js", "GOARCH=wasm", "CGO_ENABLED=0")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("go %s: %w\n%s", strings.Join(args, " "), err, stderr.String())
	}
	return string(out), nil
}

func goEnv(key string) (string, error) {
	out, err := exec.Command("go", "env", key).Output()
	if err != nil {
		return "", fmt.Errorf("go env %s: %w", key, err)
	}
	return strings.TrimSpace(string(out)), nil
}

func gzipBytes(b []byte) ([]byte, error) {
	var buf bytes.Buffer
	zw, err := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	if err != nil {
		return nil, err
	}
	if _, err := zw.Write(b); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func assetsExist(m manifest) bool {
	for _, a := range m.Assets {
		if _, err := os.Stat(filepath.Join("public", a.URL)); err != nil {
			return false
		}
	}
	return len(m.Assets) > 0
}

func copyFile(src, dst string) error {
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	return os.WriteFile(dst, b, 0o644)
}

func readJSON(name string, v any) error {
	b, err := os.ReadFile(name)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

func mb(n int) float64 { return float64(n) / (1 << 20) }
