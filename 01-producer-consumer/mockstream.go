//////////////////////////////////////////////////////////////////////
//
// DO NOT EDIT THIS PART
// Your task is to edit `main.go`
//

package main

import (
	"errors"
	"strings"
	"time"
)

// GetMockStream returns a mock stream for this exercise.
func GetMockStream() Stream {
	return Stream{0, mockdata}
}

// Stream is a mock tweet stream. It is not thread-safe.
type Stream struct {
	pos    int
	tweets []Tweet
}

// ErrEOF means the stream has no more tweets.
var ErrEOF = errors.New("End of File")

// Next waits, then returns the next tweet.
// It returns ErrEOF after the last tweet.
func (s *Stream) Next() (*Tweet, error) {
	time.Sleep(320 * time.Millisecond)
	if s.pos >= len(s.tweets) {
		return &Tweet{}, ErrEOF
	}

	tweet := s.tweets[s.pos]
	s.pos++

	return &tweet, nil
}

// Tweet is a simplified tweet.
type Tweet struct {
	Username string
	Text     string
}

// IsTalkingAboutGo checks whether a tweet mentions Go.
func (t *Tweet) IsTalkingAboutGo() bool {
	time.Sleep(330 * time.Millisecond)

	hasGolang := strings.Contains(strings.ToLower(t.Text), "golang")
	hasGopher := strings.Contains(strings.ToLower(t.Text), "gopher")

	return hasGolang || hasGopher
}

var mockdata = []Tweet{
	{
		"davecheney",
		"#golang top tip: if your unit tests import any other package you wrote, including themselves, they're not unit tests.",
	}, {
		"beertocode",
		"Backend developer, doing frontend featuring the eternal struggle of centering something. #coding",
	}, {
		"ironzeb",
		"Re: Popularity of Golang in China: My thinking nowadays is that it had a lot to do with this book and author https://github.com/astaxie/build-web-application-with-golang",
	}, {
		"beertocode",
		"Looking forward to the #gopher meetup in Hsinchu tonight with @ironzeb!",
	}, {
		"vampirewalk666",
		"I just wrote a golang slack bot! It reports the state of github repository. #Slack #golang",
	},
}
