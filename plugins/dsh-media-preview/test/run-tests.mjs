/**
 * 单进程测试入口（见 README 的「测试」一节）。
 *
 * 为什么不用 `node --test <dir>`：DSH 的文件沙箱禁止子进程通过管道通信，
 * `node --test` 默认每个测试文件起一个子进程，会直接 EPERM。这里改成把测试
 * 文件 import 进当前进程 —— node:test 在非 --test 运行时会直接执行注册的用例，
 * 失败以非零退出码体现，足够 CI/本地使用。
 */
import './path-guard.test.js';
import './http-range.test.js';
import './client-extract.test.js';
import './client-skip.test.js';
import './client-cards.test.js';
import './allowed-roots.test.js';
import './host-routes.test.js';
