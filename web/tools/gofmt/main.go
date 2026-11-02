//go:build js && wasm

// Command gofmt exposes go/format to the editor as the JavaScript function
// goFormat(src), which returns {output} or {error}.
package main

import (
	"go/format"
	"syscall/js"
)

func main() {
	js.Global().Set("goFormat", js.FuncOf(func(_ js.Value, args []js.Value) any {
		out, err := format.Source([]byte(args[0].String()))
		if err != nil {
			return map[string]any{"error": err.Error()}
		}
		return map[string]any{"output": string(out)}
	}))
	// Stay alive so goFormat keeps working after main would return.
	select {}
}
