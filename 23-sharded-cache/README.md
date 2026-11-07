# Sharded Concurrent Cache: Reducing Lock Contention

`Cache` is a key-value cache. It is already correct. One mutex protects
one map, so concurrent calls do not race.

But every `Do` call holds that one mutex for the whole call. This
includes the time spent in the caller's `work` function. A slow call for
key `"a"` then blocks an unrelated call for key `"b"`. The two keys do
not conflict, but the cache still makes them run one at a time.

```
today:  Do("a", slow work) ──▶ lock ──▶ held for the whole call ──▶ unlock
        Do("b", fast work) ──────────▶ blocked on the SAME lock, even
                                       though "a" and "b" never conflict

goal:   Do("a", slow work) ──▶ shard[a]'s lock ──▶ held only by "a"
        Do("b", fast work) ──▶ shard[b]'s lock ──▶ proceeds immediately,
                                                   independent of "a"
```

Your task is to split `Cache` into N independent shards. Use
`const numShards = 16` for example. Each shard needs its own mutex and
sub-map. Calls for keys in different shards can then run in parallel.
Calls for the same key remain serialized by that shard's lock.

Use a simple, deterministic shard function. The tests expect sharding by
the key's first byte:

```go
shardIndex := int(key[0]) % numShards
```

An empty key has no first byte. Send it to shard 0. Do not panic.

Keep the signature the same. `Cache` must remain a drop-in replacement:

```go
func NewCache() *Cache
func (c *Cache) Do(key string, work func(cur int) int) int
```

## Test your solution

The tests must pass:

```
go test
go test --race
```
