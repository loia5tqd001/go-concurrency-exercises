//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"crypto/rand"
	"encoding/base64"
	"io"
)

// MakeSessionID returns a random session ID.
func MakeSessionID() (string, error) {
	buf := make([]byte, 26)
	_, err := io.ReadFull(rand.Reader, buf)
	if err != nil {
		return "", err
	}

	return base64.StdEncoding.EncodeToString(buf), nil
}
