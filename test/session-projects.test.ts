import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { CodexDesktopClient, mergeDesktopSessionStatuses } from '../src/connector/codex-desktop.js';
import { SessionStatusOverlay, type SessionProject } from '../src/shared/session-status.js';
import { SessionSidebar } from '../web/src/session-sidebar.js';
import type { Session } from '../web/src/app-types.js';

const project: SessionProject = { status: 'assigned', id: 'project-a', name: 'Custom project label' };
const unavailable: SessionProject = { status: 'unavailable' };

test('Desktop project labels join by project ID regardless of cwd, rename, worktree or another host', async t => {
  const desktop = new CodexDesktopClient();
  t.after(() => desktop.close());
  let label = 'Custom project label';
  desktop.callTool = async request => ({ success: true, structuredContent: request.tool === 'list_projects'
    ? { projects: [
      { projectId: 'project-a', label, hostId: 'local', projectKind: 'local' },
      { projectId: 'project-a', label: 'Foreign project', hostId: 'remote', projectKind: 'remote' },
    ] } : { threads: [
      { id: 'worktree', kind: 'codex', hostId: 'local', status: 'active', projectId: 'project-a', cwd: '/home/example/.codex/worktrees/branch/repo' },
      { id: 'moved', kind: 'codex', hostId: 'local', status: 'idle', projectId: 'project-a', cwd: '/workspace/unrelated-repo' },
      { id: 'no-project', kind: 'codex', hostId: 'local', status: 'idle', projectId: null },
      { id: 'unknown-project', kind: 'codex', hostId: 'local', status: 'idle', projectId: 'missing' },
      { id: 'legacy', kind: 'codex', status: 'idle' },
      { id: 'worktree', kind: 'codex', hostId: 'remote', status: 'idle', projectId: 'project-a' },
      { id: 'chatgpt', kind: 'chatgpt', projectId: 'project-a' },
    ] } });
  const rows = await desktop.listThreads({ callerThreadId: 'worktree' });
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0].project, project);
  assert.deepEqual(rows[1].project, project);
  assert.deepEqual(rows[2].project, { status: 'unassigned' });
  assert.deepEqual(rows[3].project, unavailable);
  assert.deepEqual(rows[4].project, unavailable);
  label = 'Renamed project';
  assert.equal((await desktop.listThreads({ callerThreadId: 'worktree' }))[0].project?.status, 'assigned');
  assert.deepEqual((await desktop.listThreads({ callerThreadId: 'worktree' }))[0].project,
    { ...project, name: label });
});

test('unavailable project lookup retains statuses and distinguishes unassigned from unknown', async t => {
  const desktop = new CodexDesktopClient();
  t.after(() => desktop.close());
  desktop.callTool = async request => {
    if (request.tool === 'list_projects') throw new Error('desktop_tool_unavailable:list_projects');
    return { success: true, structuredContent: { threads: [
      { id: 'a', kind: 'codex', hostId: 'local', status: 'active', projectId: 'project-a' },
      { id: 'b', kind: 'codex', hostId: 'local', status: 'idle', projectId: null },
    ] } };
  };
  assert.deepEqual(await desktop.listThreads({ callerThreadId: 'a' }), [
    { id: 'a', status: 'active', project: unavailable },
    { id: 'b', status: 'idle', project: { status: 'unassigned' } },
  ]);
});

test('project updates apply with unchanged statuses and never overwrite execution directories or cross channels', () => {
  const rows: Session[] = [{ id: 'a', title: 'Task', cwd: '/workspace/other-repo', status: 'idle', project: unavailable }];
  const snapshot = { revision: 2, threads: [{ id: 'a', status: 'idle', project }] };
  const overlay = new SessionStatusOverlay();
  overlay.accept(snapshot, 0);
  const updated = overlay.apply(rows, 'a', 1);
  assert.deepEqual(updated[0].project, project);
  assert.equal(updated[0].cwd, rows[0].cwd);
  assert.equal(updated[0].status, 'active');
  const idle = overlay.apply(rows, '', 1);
  assert.equal(overlay.apply(idle, '', 2), idle);
  assert.equal(overlay.accept({ revision: 1, threads: [{ id: 'a', status: 'idle', project: unavailable }] }, 3), false);
  assert.deepEqual(overlay.apply(rows, '', 4)[0].project, project);
  assert.deepEqual(overlay.apply(rows, '', 16_000)[0].project, unavailable);
  const otherChannel = new SessionStatusOverlay();
  assert.deepEqual(otherChannel.apply(rows)[0].project, unavailable);
  overlay.accept({ revision: 3, threads: [{ id: 'a', status: 'idle', project: { status: 'unassigned' } }] }, 5);
  assert.deepEqual(overlay.apply(rows, '', 6)[0].project, { status: 'unassigned' });
  const merged = mergeDesktopSessionStatuses(rows, snapshot.threads, ['a']);
  assert.equal(merged[0].cwd, rows[0].cwd);
  assert.deepEqual(merged[0].project, project);
  assert.equal(merged[0].status, 'active');
});

test('sidebar shows Desktop labels and searches them while headless sessions retain folder labels', () => {
  const sessions: Session[] = [
    { id: 'a', title: 'Worktree task', cwd: '/home/example/.codex/worktrees/branch/repo', project },
    { id: 'b', title: 'Different repo', cwd: '/workspace/other-repo', project },
    { id: 'c', title: 'Explicitly unassigned', cwd: '/workspace/misleading', project: { status: 'unassigned' } },
    { id: 'd', title: 'Pending metadata', cwd: '/workspace/misleading', project: unavailable },
    { id: 'e', title: 'Headless task', cwd: '/workspace/backend' },
  ];
  const render = (search = '') => parseHTML(renderToStaticMarkup(createElement(SessionSidebar, {
    open: true, environmentId: 'local', environmentIds: ['local'], onlineEnvironmentIds: ['local'], sessions,
    selectedThreadId: 'a', executionState: 'idle', attention: {}, searchOpen: false, search,
    onSearchOpenChange() {}, onSearchChange() {}, onEnvironmentChange() {}, onNewSession() {}, onClose() {}, onSelect() {},
  }))).document;
  const document = render();
  assert.deepEqual([...document.querySelectorAll('.session-project')].map(node => node.textContent), [
    'Custom project label', 'Custom project label', '未分配项目', '项目待同步', 'backend',
  ]);
  assert.equal(render('custom project').querySelectorAll('.session-card').length, 2);
  assert.equal(render('other-repo').querySelectorAll('.session-card').length, 1);
});
