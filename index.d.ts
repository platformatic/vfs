import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';

export interface VFSOptions {
  moduleHooks?: boolean;
  virtualCwd?: boolean;
  overlay?: boolean;
}

export interface MkdirOptions {
  recursive?: boolean;
  mode?: number;
}

export interface ReaddirOptions {
  withFileTypes?: boolean;
}

export interface WatchOptions {
  persistent?: boolean;
  recursive?: boolean;
  interval?: number;
  signal?: AbortSignal;
}

export interface WatchFileOptions {
  persistent?: boolean;
  interval?: number;
}

export interface ReadStreamOptions {
  start?: number;
  end?: number;
  highWaterMark?: number;
  encoding?: BufferEncoding;
  autoClose?: boolean;
}

export interface StatOptions {
  bigint?: boolean;
}

export class VirtualStats {
  dev: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  blksize: number;
  ino: number;
  size: number;
  blocks: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
  birthtime: Date;

  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}

export class VirtualDirent {
  get name(): string;
  get parentPath(): string;
  get path(): string;

  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}

export class VirtualReadStream extends Readable {
  constructor(vfs: VirtualFileSystem, filePath: string, options?: ReadStreamOptions);
  get path(): string;
}

export class VFSWatcher extends EventEmitter {
  close(): void;
  unref(): this;
  ref(): this;
}

export interface WatchAsyncEvent {
  eventType: string;
  filename: string;
}

export class VFSWatchAsyncIterable implements AsyncIterable<WatchAsyncEvent> {
  [Symbol.asyncIterator](): AsyncIterator<WatchAsyncEvent>;
  next(): Promise<IteratorResult<WatchAsyncEvent>>;
  return(): Promise<IteratorResult<WatchAsyncEvent>>;
  throw(error?: unknown): Promise<IteratorResult<WatchAsyncEvent>>;
}

export class VFSStatWatcher extends EventEmitter {
  addListener(listener: (curr: VirtualStats, prev: VirtualStats) => void): void;
  removeListener(listener: (curr: VirtualStats, prev: VirtualStats) => void): boolean;
  hasNoListeners(): boolean;
  stop(): void;
  unref(): this;
  ref(): this;
}

export interface VFSPromisesAPI {
  readFile(filePath: string, options?: { encoding?: null } | null): Promise<Buffer>;
  readFile(filePath: string, options: BufferEncoding | { encoding: BufferEncoding }): Promise<string>;
  readFile(filePath: string, options?: BufferEncoding | { encoding?: BufferEncoding | null } | null): Promise<Buffer | string>;
  writeFile(filePath: string, data: string | Buffer, options?: { encoding?: BufferEncoding; mode?: number } | BufferEncoding): Promise<void>;
  appendFile(filePath: string, data: string | Buffer, options?: { encoding?: BufferEncoding; mode?: number } | BufferEncoding): Promise<void>;
  stat(filePath: string, options?: StatOptions): Promise<VirtualStats>;
  lstat(filePath: string, options?: StatOptions): Promise<VirtualStats>;
  readdir(dirPath: string, options?: ReaddirOptions & { withFileTypes?: false }): Promise<string[]>;
  readdir(dirPath: string, options: ReaddirOptions & { withFileTypes: true }): Promise<VirtualDirent[]>;
  readdir(dirPath: string, options?: ReaddirOptions): Promise<string[] | VirtualDirent[]>;
  mkdir(dirPath: string, options?: MkdirOptions): Promise<string | undefined>;
  rmdir(dirPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  copyFile(src: string, dest: string, mode?: number): Promise<void>;
  realpath(filePath: string, options?: { encoding?: BufferEncoding }): Promise<string>;
  readlink(linkPath: string, options?: { encoding?: BufferEncoding }): Promise<string>;
  symlink(target: string, path: string, type?: string): Promise<void>;
  access(filePath: string, mode?: number): Promise<void>;
  watch(filePath: string, options?: WatchOptions): VFSWatchAsyncIterable;
}

type Callback<T = void> = T extends void
  ? (err: NodeJS.ErrnoException | null) => void
  : (err: NodeJS.ErrnoException | null, result: T) => void;

export class VirtualFileSystem {
  constructor(provider?: VirtualProvider, options?: VFSOptions);
  constructor(options?: VFSOptions);

  get provider(): VirtualProvider;
  get mountPoint(): string | null;
  get mounted(): boolean;
  get readonly(): boolean;
  get overlay(): boolean;
  get virtualCwdEnabled(): boolean;

  // Virtual Working Directory
  cwd(): string;
  chdir(dirPath: string): void;
  resolvePath(inputPath: string): string;

  // Mount
  mount(prefix: string): this;
  unmount(): void;
  [Symbol.dispose](): void;

  shouldHandle(inputPath: string): boolean;

  // Sync operations
  existsSync(filePath: string): boolean;
  statSync(filePath: string, options?: StatOptions): VirtualStats;
  lstatSync(filePath: string, options?: StatOptions): VirtualStats;
  readFileSync(filePath: string, options?: { encoding?: null } | null): Buffer;
  readFileSync(filePath: string, options: BufferEncoding | { encoding: BufferEncoding }): string;
  readFileSync(filePath: string, options?: BufferEncoding | { encoding?: BufferEncoding | null } | null): Buffer | string;
  writeFileSync(filePath: string, data: string | Buffer, options?: { encoding?: BufferEncoding; mode?: number } | BufferEncoding): void;
  appendFileSync(filePath: string, data: string | Buffer, options?: { encoding?: BufferEncoding; mode?: number } | BufferEncoding): void;
  readdirSync(dirPath: string, options?: ReaddirOptions & { withFileTypes?: false }): string[];
  readdirSync(dirPath: string, options: ReaddirOptions & { withFileTypes: true }): VirtualDirent[];
  readdirSync(dirPath: string, options?: ReaddirOptions): string[] | VirtualDirent[];
  mkdirSync(dirPath: string, options?: MkdirOptions): string | undefined;
  rmdirSync(dirPath: string): void;
  unlinkSync(filePath: string): void;
  renameSync(oldPath: string, newPath: string): void;
  copyFileSync(src: string, dest: string, mode?: number): void;
  realpathSync(filePath: string, options?: { encoding?: BufferEncoding }): string;
  readlinkSync(linkPath: string, options?: { encoding?: BufferEncoding }): string;
  symlinkSync(target: string, path: string, type?: string): void;
  accessSync(filePath: string, mode?: number): void;

  // File descriptor operations
  openSync(filePath: string, flags?: string, mode?: number): number;
  closeSync(fd: number): void;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
  fstatSync(fd: number, options?: StatOptions): VirtualStats;

  // Callback operations
  readFile(filePath: string, callback: Callback<Buffer>): void;
  readFile(filePath: string, options: BufferEncoding | { encoding: BufferEncoding }, callback: Callback<string>): void;
  readFile(filePath: string, options: { encoding?: BufferEncoding | null } | null | undefined, callback: Callback<Buffer | string>): void;
  writeFile(filePath: string, data: string | Buffer, callback: Callback): void;
  writeFile(filePath: string, data: string | Buffer, options: { encoding?: BufferEncoding; mode?: number } | BufferEncoding, callback: Callback): void;
  stat(filePath: string, callback: Callback<VirtualStats>): void;
  stat(filePath: string, options: StatOptions, callback: Callback<VirtualStats>): void;
  lstat(filePath: string, callback: Callback<VirtualStats>): void;
  lstat(filePath: string, options: StatOptions, callback: Callback<VirtualStats>): void;
  readdir(dirPath: string, callback: Callback<string[]>): void;
  readdir(dirPath: string, options: ReaddirOptions & { withFileTypes: true }, callback: Callback<VirtualDirent[]>): void;
  readdir(dirPath: string, options: ReaddirOptions, callback: Callback<string[] | VirtualDirent[]>): void;
  realpath(filePath: string, callback: Callback<string>): void;
  realpath(filePath: string, options: { encoding?: BufferEncoding }, callback: Callback<string>): void;
  readlink(linkPath: string, callback: Callback<string>): void;
  readlink(linkPath: string, options: { encoding?: BufferEncoding }, callback: Callback<string>): void;
  access(filePath: string, callback: Callback): void;
  access(filePath: string, mode: number, callback: Callback): void;
  open(filePath: string, callback: Callback<number>): void;
  open(filePath: string, flags: string, callback: Callback<number>): void;
  open(filePath: string, flags: string, mode: number, callback: Callback<number>): void;
  close(fd: number, callback: Callback): void;
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number | null, callback: (err: NodeJS.ErrnoException | null, bytesRead: number, buffer: Buffer) => void): void;
  fstat(fd: number, callback: Callback<VirtualStats>): void;
  fstat(fd: number, options: StatOptions, callback: Callback<VirtualStats>): void;

  // Stream operations
  createReadStream(filePath: string, options?: ReadStreamOptions): VirtualReadStream;

  // Watch operations
  watch(filePath: string, options?: WatchOptions, listener?: (eventType: string, filename: string) => void): VFSWatcher;
  watch(filePath: string, listener?: (eventType: string, filename: string) => void): VFSWatcher;
  watchFile(filePath: string, options?: WatchFileOptions, listener?: (curr: VirtualStats, prev: VirtualStats) => void): VFSStatWatcher;
  watchFile(filePath: string, listener?: (curr: VirtualStats, prev: VirtualStats) => void): VFSStatWatcher;
  unwatchFile(filePath: string, listener?: (curr: VirtualStats, prev: VirtualStats) => void): void;

  // Promise API
  get promises(): VFSPromisesAPI;
}

export class VirtualProvider {
  get readonly(): boolean;
  get supportsSymlinks(): boolean;
  get supportsWatch(): boolean;

  // Essential primitives
  open(path: string, flags?: string, mode?: number): Promise<unknown>;
  openSync(path: string, flags?: string, mode?: number): unknown;
  stat(path: string, options?: StatOptions): Promise<VirtualStats>;
  statSync(path: string, options?: StatOptions): VirtualStats;
  lstat(path: string, options?: StatOptions): Promise<VirtualStats>;
  lstatSync(path: string, options?: StatOptions): VirtualStats;
  readdir(path: string, options?: ReaddirOptions): Promise<string[] | VirtualDirent[]>;
  readdirSync(path: string, options?: ReaddirOptions): string[] | VirtualDirent[];
  mkdir(path: string, options?: MkdirOptions): Promise<string | undefined>;
  mkdirSync(path: string, options?: MkdirOptions): string | undefined;
  rmdir(path: string): Promise<void>;
  rmdirSync(path: string): void;
  unlink(path: string): Promise<void>;
  unlinkSync(path: string): void;
  rename(oldPath: string, newPath: string): Promise<void>;
  renameSync(oldPath: string, newPath: string): void;

  // Default implementations
  readFile(path: string, options?: BufferEncoding | { encoding?: BufferEncoding | null } | null): Promise<Buffer | string>;
  readFileSync(path: string, options?: BufferEncoding | { encoding?: BufferEncoding | null } | null): Buffer | string;
  writeFile(path: string, data: string | Buffer, options?: { encoding?: BufferEncoding; mode?: number } | BufferEncoding): Promise<void>;
  writeFileSync(path: string, data: string | Buffer, options?: { encoding?: BufferEncoding; mode?: number } | BufferEncoding): void;
  appendFile(path: string, data: string | Buffer, options?: { encoding?: BufferEncoding; mode?: number } | BufferEncoding): Promise<void>;
  appendFileSync(path: string, data: string | Buffer, options?: { encoding?: BufferEncoding; mode?: number } | BufferEncoding): void;
  exists(path: string): Promise<boolean>;
  existsSync(path: string): boolean;
  copyFile(src: string, dest: string, mode?: number): Promise<void>;
  copyFileSync(src: string, dest: string, mode?: number): void;
  internalModuleStat(path: string): number;
  realpath(path: string, options?: { encoding?: BufferEncoding }): Promise<string>;
  realpathSync(path: string, options?: { encoding?: BufferEncoding }): string;
  access(path: string, mode?: number): Promise<void>;
  accessSync(path: string, mode?: number): void;

  // Symlink operations
  readlink(path: string, options?: { encoding?: BufferEncoding }): Promise<string>;
  readlinkSync(path: string, options?: { encoding?: BufferEncoding }): string;
  symlink(target: string, path: string, type?: string): Promise<void>;
  symlinkSync(target: string, path: string, type?: string): void;

  // Watch operations
  watch(path: string, options?: WatchOptions): VFSWatcher;
  watchAsync(path: string, options?: WatchOptions): VFSWatchAsyncIterable;
  watchFile(path: string, options?: WatchFileOptions, listener?: (curr: VirtualStats, prev: VirtualStats) => void): VFSStatWatcher;
  unwatchFile(path: string, listener?: (curr: VirtualStats, prev: VirtualStats) => void): void;
}

export class MemoryProvider extends VirtualProvider {
  constructor();
  get readonly(): boolean;
  get supportsWatch(): boolean;
  get supportsSymlinks(): boolean;
  setReadOnly(): void;
}

export class RealFSProvider extends VirtualProvider {
  constructor(rootPath: string);
  get rootPath(): string;
  get readonly(): boolean;
  get supportsSymlinks(): boolean;
}

export class SqliteProvider extends VirtualProvider {
  constructor(pathOrMemory?: string);
  get readonly(): boolean;
  get supportsWatch(): boolean;
  get supportsSymlinks(): boolean;
  setReadOnly(): void;
  close(): void;
}

export function create(options?: VFSOptions): VirtualFileSystem;
export function create(provider: VirtualProvider, options?: VFSOptions): VirtualFileSystem;
