package main

import (
	"context"
	"time"
)

// LayerLatency is the normal time one layer takes.
const LayerLatency = 300 * time.Millisecond

// callLayer waits for LayerLatency or stops when ctx is done.
func callLayer(ctx context.Context, result string) (string, error) {
	timer := time.NewTimer(LayerLatency)
	defer timer.Stop()

	select {
	case <-timer.C:
		return result, nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// CallLayerA simulates the first layer.
func CallLayerA(ctx context.Context) (string, error) {
	return callLayer(ctx, "A")
}

// CallLayerB simulates the second layer.
func CallLayerB(ctx context.Context) (string, error) {
	return callLayer(ctx, "B")
}

// CallLayerC simulates the third layer.
func CallLayerC(ctx context.Context) (string, error) {
	return callLayer(ctx, "C")
}
