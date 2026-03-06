import { expect, test } from 'tstyche';
import {
  create,
  VirtualFileSystem,
  VirtualProvider,
  MemoryProvider,
  RealFSProvider,
  SqliteProvider,
  VirtualStats,
  VirtualDirent,
  VirtualReadStream,
  VFSWatcher,
  VFSStatWatcher,
  VFSPromisesAPI,
} from '@platformatic/vfs';

// create() factory
test('create() returns VirtualFileSystem', () => {
  expect(create()).type.toBe<VirtualFileSystem>();
  expect(create({})).type.toBe<VirtualFileSystem>();
  expect(create({ overlay: true })).type.toBe<VirtualFileSystem>();
  expect(create(new MemoryProvider())).type.toBe<VirtualFileSystem>();
  expect(create(new MemoryProvider(), { moduleHooks: false })).type.toBe<VirtualFileSystem>();
});

// VirtualFileSystem sync methods
test('readFileSync returns Buffer by default', () => {
  const vfs = create();
  expect(vfs.readFileSync('/file')).type.toBe<Buffer>();
});

test('readFileSync returns string with encoding', () => {
  const vfs = create();
  expect(vfs.readFileSync('/file', 'utf8')).type.toBe<string>();
  expect(vfs.readFileSync('/file', { encoding: 'utf8' })).type.toBe<string>();
});

test('statSync returns VirtualStats', () => {
  const vfs = create();
  expect(vfs.statSync('/file')).type.toBe<VirtualStats>();
  expect(vfs.lstatSync('/file')).type.toBe<VirtualStats>();
});

test('existsSync returns boolean', () => {
  const vfs = create();
  expect(vfs.existsSync('/file')).type.toBe<boolean>();
});

test('readdirSync returns string[] by default', () => {
  const vfs = create();
  expect(vfs.readdirSync('/dir')).type.toBe<string[]>();
});

test('readdirSync returns VirtualDirent[] with withFileTypes', () => {
  const vfs = create();
  expect(vfs.readdirSync('/dir', { withFileTypes: true })).type.toBe<VirtualDirent[]>();
});

test('mkdirSync returns string | undefined', () => {
  const vfs = create();
  expect(vfs.mkdirSync('/dir', { recursive: true })).type.toBe<string | undefined>();
});

test('fd operations', () => {
  const vfs = create();
  expect(vfs.openSync('/file')).type.toBe<number>();
  expect(vfs.fstatSync(3)).type.toBe<VirtualStats>();
});

// mount / unmount
test('mount returns this', () => {
  const vfs = create();
  expect(vfs.mount('/mnt')).type.toBe<VirtualFileSystem>();
});

test('unmount returns void', () => {
  const vfs = create();
  expect(vfs.unmount()).type.toBe<void>();
});

// Stream
test('createReadStream returns VirtualReadStream', () => {
  const vfs = create();
  expect(vfs.createReadStream('/file')).type.toBe<VirtualReadStream>();
});

// Watch
test('watch returns VFSWatcher', () => {
  const vfs = create();
  expect(vfs.watch('/file')).type.toBe<VFSWatcher>();
});

// Promises API
test('promises.readFile returns Promise<Buffer> by default', () => {
  const vfs = create();
  expect(vfs.promises.readFile('/file')).type.toBe<Promise<Buffer>>();
});

test('promises.readFile returns Promise<string> with encoding', () => {
  const vfs = create();
  expect(vfs.promises.readFile('/file', 'utf8')).type.toBe<Promise<string>>();
  expect(vfs.promises.readFile('/file', { encoding: 'utf8' })).type.toBe<Promise<string>>();
});

test('promises.stat returns Promise<VirtualStats>', () => {
  const vfs = create();
  expect(vfs.promises.stat('/file')).type.toBe<Promise<VirtualStats>>();
});

test('promises.readdir returns Promise<string[]> by default', () => {
  const vfs = create();
  expect(vfs.promises.readdir('/dir')).type.toBe<Promise<string[]>>();
});

test('promises.readdir returns Promise<VirtualDirent[]> with withFileTypes', () => {
  const vfs = create();
  expect(vfs.promises.readdir('/dir', { withFileTypes: true })).type.toBe<Promise<VirtualDirent[]>>();
});

// VirtualStats methods return booleans
test('VirtualStats type check methods return boolean', () => {
  const stats = new VirtualStats();
  expect(stats.isFile()).type.toBe<boolean>();
  expect(stats.isDirectory()).type.toBe<boolean>();
  expect(stats.isSymbolicLink()).type.toBe<boolean>();
  expect(stats.isBlockDevice()).type.toBe<boolean>();
  expect(stats.isCharacterDevice()).type.toBe<boolean>();
  expect(stats.isFIFO()).type.toBe<boolean>();
  expect(stats.isSocket()).type.toBe<boolean>();
});

// VirtualProvider subclassing
test('VirtualProvider can be subclassed', () => {
  class MyProvider extends VirtualProvider {
    statSync(path: string): VirtualStats {
      return {} as VirtualStats;
    }
  }
  expect(new MyProvider()).type.toBeAssignableTo<VirtualProvider>();
});

// MemoryProvider constructor
test('MemoryProvider constructor takes no args', () => {
  expect(new MemoryProvider()).type.toBe<MemoryProvider>();
});

test('MemoryProvider is a VirtualProvider', () => {
  expect(new MemoryProvider()).type.toBeAssignableTo<VirtualProvider>();
});

// RealFSProvider constructor
test('RealFSProvider constructor requires rootPath', () => {
  expect(new RealFSProvider('/tmp')).type.toBe<RealFSProvider>();
});

test('RealFSProvider is a VirtualProvider', () => {
  expect(new RealFSProvider('/tmp')).type.toBeAssignableTo<VirtualProvider>();
});

test('RealFSProvider has rootPath getter', () => {
  const provider = new RealFSProvider('/tmp');
  expect(provider.rootPath).type.toBe<string>();
});

// SqliteProvider constructor
test('SqliteProvider constructor takes optional path', () => {
  expect(new SqliteProvider()).type.toBe<SqliteProvider>();
  expect(new SqliteProvider(':memory:')).type.toBe<SqliteProvider>();
});

test('SqliteProvider is a VirtualProvider', () => {
  expect(new SqliteProvider()).type.toBeAssignableTo<VirtualProvider>();
});

test('SqliteProvider has setReadOnly and close methods', () => {
  const provider = new SqliteProvider();
  expect(provider.setReadOnly()).type.toBe<void>();
  expect(provider.close()).type.toBe<void>();
});

test('SqliteProvider can be passed to create', () => {
  expect(create(new SqliteProvider())).type.toBe<VirtualFileSystem>();
  expect(create(new SqliteProvider(), { moduleHooks: false })).type.toBe<VirtualFileSystem>();
});

// Properties
test('VirtualFileSystem properties', () => {
  const vfs = create();
  expect(vfs.mounted).type.toBe<boolean>();
  expect(vfs.mountPoint).type.toBe<string | null>();
  expect(vfs.readonly).type.toBe<boolean>();
  expect(vfs.overlay).type.toBe<boolean>();
  expect(vfs.virtualCwdEnabled).type.toBe<boolean>();
  expect(vfs.provider).type.toBe<VirtualProvider>();
});
