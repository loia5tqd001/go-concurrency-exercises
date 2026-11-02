// An in-memory filesystem with the subset of Node's callback-style `fs` API
// that Go's GOOS=js port calls (see $GOROOT/src/syscall/fs_js.go). The Go
// compiler, linker and test binaries all run against one of these instead
// of a real disk.
//
// Callbacks always run on a later microtask, as with Node's real fs. A
// synchronous callback would re-enter Go in the middle of its call into
// JavaScript; the runtime then runs other goroutines before that call
// returns, and if one of them exits the program, wasm_exec.js crashes on the
// instance it has already torn down.

type Callback<T = unknown> = (err: Error | null, result?: T) => void;

interface FileNode {
  kind: "file";
  ino: number;
  mode: number;
  mtimeMs: number;
  data: Uint8Array;
  size: number;
}

interface DirNode {
  kind: "dir";
  ino: number;
  mode: number;
  mtimeMs: number;
  children: Map<string, Node>;
}

type Node = FileNode | DirNode;

interface OpenFile {
  node: FileNode | DirNode;
  flags: number;
  pos: number;
}

const S_IFCHR = 0o020000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

// Linux values; fs_js.go reads them from fs.constants, so any consistent set
// works.
const constants = {
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 0o100,
  O_EXCL: 0o200,
  O_TRUNC: 0o1000,
  O_APPEND: 0o2000,
  O_DIRECTORY: 0o200000,
};

function fsError(code: string, syscall: string, path?: string): Error {
  const err = new Error(`${code}: ${syscall}${path ? ` '${path}'` : ""}`);
  return Object.assign(err, { code });
}

function reply<T>(cb: Callback<T>, err: Error | null, result?: T): void {
  queueMicrotask(() => cb(err, result));
}

export type OutputHandler = (fd: 1 | 2, bytes: Uint8Array) => void;

export class MemFS {
  readonly constants = constants;
  private root: DirNode;
  private fds = new Map<number, OpenFile>();
  private nextFd = 3;
  private nextIno = 1;
  private cwdPath = "/";
  onOutput: OutputHandler = () => {};

  constructor() {
    this.root = this.newDir(0o755);
  }

  // ---- helpers for the host (not part of the Node API) ----

  writeFile(path: string, data: Uint8Array | string): void {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const { dir, name } = this.parent(path, true);
    const node = this.newFile(0o644);
    node.data = bytes;
    node.size = bytes.length;
    dir.children.set(name, node);
  }

  readFile(path: string): Uint8Array {
    const node = this.lookup(path);
    if (!node) throw fsError("ENOENT", "open", path);
    if (node.kind !== "file") throw fsError("EISDIR", "read", path);
    return node.data.subarray(0, node.size);
  }

  mkdirAll(path: string): void {
    let dir = this.root;
    for (const part of this.split(path)) {
      let next = dir.children.get(part);
      if (!next) {
        next = this.newDir(0o755);
        dir.children.set(part, next);
      }
      if (next.kind !== "dir") throw fsError("ENOTDIR", "mkdir", path);
      dir = next;
    }
  }

  removeAll(path: string): void {
    const parts = this.split(path);
    const name = parts.pop();
    if (name === undefined) return;
    const dir = this.lookup("/" + parts.join("/"));
    if (dir?.kind === "dir") dir.children.delete(name);
  }

  cwd(): string {
    return this.cwdPath;
  }

  chdir(path: string): void {
    const abs = this.resolve(path);
    const node = this.lookup(abs);
    if (!node) throw fsError("ENOENT", "chdir", path);
    if (node.kind !== "dir") throw fsError("ENOTDIR", "chdir", path);
    this.cwdPath = abs;
  }

  // ---- Node fs API used by fs_js.go and wasm_exec.js ----

  writeSync(fd: number, buf: Uint8Array): number {
    if (fd === 1 || fd === 2) {
      // Copy: buf may be a view into the Go instance's memory.
      this.onOutput(fd, buf.slice());
      return buf.length;
    }
    return this.writeAt(fd, buf, null);
  }

  write(fd: number, buf: Uint8Array, offset: number, length: number, position: number | null, cb: Callback<number>): void {
    this.call(cb, () => {
      const chunk = buf.subarray(offset, offset + length);
      if (fd === 1 || fd === 2) return this.writeSync(fd, chunk);
      return this.writeAt(fd, chunk, position);
    });
  }

  read(fd: number, buf: Uint8Array, offset: number, length: number, position: number | null, cb: Callback<number>): void {
    this.call(cb, () => {
      if (fd === 0) return 0; // stdin is always empty
      const f = this.fd(fd);
      if (f.node.kind !== "file") throw fsError("EISDIR", "read");
      const node = f.node;
      const start = position ?? f.pos;
      const n = Math.max(0, Math.min(length, node.size - start));
      buf.set(node.data.subarray(start, start + n), offset);
      if (position === null) f.pos += n;
      return n;
    });
  }

  open(path: string, flags: number, mode: number, cb: Callback<number>): void {
    this.call(cb, () => {
      let node = this.lookup(path);
      if (node && flags & constants.O_CREAT && flags & constants.O_EXCL) throw fsError("EEXIST", "open", path);
      if (!node) {
        if (!(flags & constants.O_CREAT)) throw fsError("ENOENT", "open", path);
        const { dir, name } = this.parent(path, false);
        node = this.newFile(mode & 0o777);
        dir.children.set(name, node);
      }
      if (flags & constants.O_DIRECTORY && node.kind !== "dir") throw fsError("ENOTDIR", "open", path);
      if (node.kind === "dir" && flags & (constants.O_WRONLY | constants.O_RDWR)) throw fsError("EISDIR", "open", path);
      if (node.kind === "file" && flags & constants.O_TRUNC) {
        node.size = 0;
        node.mtimeMs = Date.now();
      }
      const fd = this.nextFd++;
      this.fds.set(fd, { node, flags, pos: 0 });
      return fd;
    });
  }

  close(fd: number, cb: Callback): void {
    this.call(cb, () => {
      if (fd <= 2) return;
      this.fd(fd);
      this.fds.delete(fd);
    });
  }

  fstat(fd: number, cb: Callback): void {
    this.call(cb, () => (fd <= 2 ? this.charDevStat() : this.stat_(this.fd(fd).node)));
  }

  stat(path: string, cb: Callback): void {
    this.call(cb, () => this.stat_(this.mustLookup(path, "stat")));
  }

  lstat(path: string, cb: Callback): void {
    this.stat(path, cb);
  }

  mkdir(path: string, perm: number, cb: Callback): void {
    this.call(cb, () => {
      if (this.lookup(path)) throw fsError("EEXIST", "mkdir", path);
      const { dir, name } = this.parent(path, false);
      dir.children.set(name, this.newDir(perm & 0o777));
    });
  }

  readdir(path: string, cb: Callback<string[]>): void {
    this.call(cb, () => {
      const node = this.mustLookup(path, "scandir");
      if (node.kind !== "dir") throw fsError("ENOTDIR", "scandir", path);
      return [...node.children.keys()].sort();
    });
  }

  unlink(path: string, cb: Callback): void {
    this.call(cb, () => {
      const { dir, name } = this.parent(path, false);
      const node = dir.children.get(name);
      if (!node) throw fsError("ENOENT", "unlink", path);
      if (node.kind === "dir") throw fsError("EISDIR", "unlink", path);
      dir.children.delete(name);
    });
  }

  rmdir(path: string, cb: Callback): void {
    this.call(cb, () => {
      const { dir, name } = this.parent(path, false);
      const node = dir.children.get(name);
      if (!node) throw fsError("ENOENT", "rmdir", path);
      if (node.kind !== "dir") throw fsError("ENOTDIR", "rmdir", path);
      if (node.children.size > 0) throw fsError("ENOTEMPTY", "rmdir", path);
      dir.children.delete(name);
    });
  }

  rename(from: string, to: string, cb: Callback): void {
    this.call(cb, () => {
      const src = this.parent(from, false);
      const node = src.dir.children.get(src.name);
      if (!node) throw fsError("ENOENT", "rename", from);
      const dst = this.parent(to, false);
      src.dir.children.delete(src.name);
      dst.dir.children.set(dst.name, node);
    });
  }

  truncate(path: string, length: number, cb: Callback): void {
    this.call(cb, () => this.truncate_(this.mustLookup(path, "truncate"), length));
  }

  ftruncate(fd: number, length: number, cb: Callback): void {
    this.call(cb, () => this.truncate_(this.fd(fd).node, length));
  }

  fsync(_fd: number, cb: Callback): void {
    reply(cb, null);
  }

  utimes(path: string, _atime: number, mtime: number, cb: Callback): void {
    this.call(cb, () => {
      this.mustLookup(path, "utime").mtimeMs = mtime * 1000;
    });
  }

  chmod(path: string, mode: number, cb: Callback): void {
    this.call(cb, () => {
      this.mustLookup(path, "chmod").mode = mode & 0o777;
    });
  }

  fchmod(fd: number, mode: number, cb: Callback): void {
    this.call(cb, () => {
      this.fd(fd).node.mode = mode & 0o777;
    });
  }

  chown(_path: string, _uid: number, _gid: number, cb: Callback): void {
    reply(cb, null);
  }

  fchown(_fd: number, _uid: number, _gid: number, cb: Callback): void {
    reply(cb, null);
  }

  lchown(_path: string, _uid: number, _gid: number, cb: Callback): void {
    reply(cb, null);
  }

  readlink(path: string, cb: Callback): void {
    reply(cb, fsError("EINVAL", "readlink", path));
  }

  symlink(_target: string, path: string, cb: Callback): void {
    reply(cb, fsError("ENOSYS", "symlink", path));
  }

  link(_existing: string, path: string, cb: Callback): void {
    reply(cb, fsError("ENOSYS", "link", path));
  }

  // ---- internals ----

  private call<T>(cb: Callback<T>, fn: () => T): void {
    let result: T;
    try {
      result = fn();
    } catch (err) {
      reply(cb, err as Error);
      return;
    }
    reply(cb, null, result);
  }

  private writeAt(fd: number, buf: Uint8Array, position: number | null): number {
    const f = this.fd(fd);
    if (f.node.kind !== "file") throw fsError("EISDIR", "write");
    const node = f.node;
    const start = f.flags & constants.O_APPEND ? node.size : (position ?? f.pos);
    const end = start + buf.length;
    if (end > node.data.length) {
      const grown = new Uint8Array(Math.max(end, node.data.length * 2, 4096));
      grown.set(node.data.subarray(0, node.size));
      node.data = grown;
    }
    node.data.set(buf, start);
    node.size = Math.max(node.size, end);
    node.mtimeMs = Date.now();
    if (position === null) f.pos = end;
    return buf.length;
  }

  private truncate_(node: Node, length: number): void {
    if (node.kind !== "file") throw fsError("EISDIR", "truncate");
    if (length > node.data.length) {
      const grown = new Uint8Array(length);
      grown.set(node.data.subarray(0, node.size));
      node.data = grown;
    } else if (length > node.size) {
      node.data.fill(0, node.size, length);
    }
    node.size = length;
    node.mtimeMs = Date.now();
  }

  private stat_(node: Node) {
    const isDir = node.kind === "dir";
    const size = isDir ? 4096 : node.size;
    return {
      dev: 1,
      ino: node.ino,
      mode: (isDir ? S_IFDIR : S_IFREG) | node.mode,
      nlink: 1,
      uid: 1000,
      gid: 1000,
      rdev: 0,
      size,
      blksize: 4096,
      blocks: Math.ceil(size / 512),
      atimeMs: node.mtimeMs,
      mtimeMs: node.mtimeMs,
      ctimeMs: node.mtimeMs,
      isDirectory: () => isDir,
    };
  }

  private charDevStat() {
    const now = Date.now();
    return {
      dev: 0, ino: 0, mode: S_IFCHR | 0o620, nlink: 1, uid: 1000, gid: 1000, rdev: 0, size: 0,
      blksize: 4096, blocks: 0, atimeMs: now, mtimeMs: now, ctimeMs: now, isDirectory: () => false,
    };
  }

  private fd(fd: number): OpenFile {
    const f = this.fds.get(fd);
    if (!f) throw fsError("EBADF", "fd");
    return f;
  }

  private newFile(mode: number): FileNode {
    return { kind: "file", ino: this.nextIno++, mode, mtimeMs: Date.now(), data: new Uint8Array(0), size: 0 };
  }

  private newDir(mode: number): DirNode {
    return { kind: "dir", ino: this.nextIno++, mode, mtimeMs: Date.now(), children: new Map() };
  }

  private resolve(path: string): string {
    const abs = path.startsWith("/") ? path : `${this.cwdPath}/${path}`;
    return "/" + this.split(abs).join("/");
  }

  private split(path: string): string[] {
    const abs = path.startsWith("/") ? path : `${this.cwdPath}/${path}`;
    const out: string[] = [];
    for (const part of abs.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") out.pop();
      else out.push(part);
    }
    return out;
  }

  private lookup(path: string): Node | undefined {
    let node: Node = this.root;
    for (const part of this.split(path)) {
      if (node.kind !== "dir") return undefined;
      const next = node.children.get(part);
      if (!next) return undefined;
      node = next;
    }
    return node;
  }

  private mustLookup(path: string, syscall: string): Node {
    const node = this.lookup(path);
    if (!node) throw fsError("ENOENT", syscall, path);
    return node;
  }

  private parent(path: string, create: boolean): { dir: DirNode; name: string } {
    const parts = this.split(path);
    const name = parts.pop();
    if (name === undefined) throw fsError("EINVAL", "open", path);
    const dirPath = "/" + parts.join("/");
    if (create) this.mkdirAll(dirPath);
    const dir = this.lookup(dirPath);
    if (!dir) throw fsError("ENOENT", "open", path);
    if (dir.kind !== "dir") throw fsError("ENOTDIR", "open", path);
    return { dir, name };
  }
}

// processShim is the `process` global wasm_exec.js expects, backed by fs for
// the working directory.
export function processShim(fs: MemFS) {
  return {
    pid: 1,
    ppid: 0,
    getuid: () => 1000,
    getgid: () => 1000,
    geteuid: () => 1000,
    getegid: () => 1000,
    getgroups: () => [1000],
    umask: () => 0o022,
    cwd: () => fs.cwd(),
    chdir: (path: string) => fs.chdir(path),
  };
}
