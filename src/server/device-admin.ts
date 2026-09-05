import { stdin, stdout } from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import QRCode from 'qrcode';
import { DeviceRegistry, type ApprovedDevice, type PendingDevice } from './device-registry.js';
import { browserPairingFragment } from '../shared/pairing-auth.js';
import { activityForDevice, activityIsCurrent, deviceActivityPath, readDeviceActivity, type DeviceActivitySnapshot } from './device-activity.js';

type DeviceAdminIo = {
  question(prompt: string): Promise<string>;
  write(text: string): void;
  close?(): void;
};

type DeviceAdminOptions = {
  registry?: DeviceRegistry;
  registryPath?: string;
  args?: string[];
  io?: DeviceAdminIo;
  language?: string;
  renderQrCode?: (value: string) => Promise<string>;
};

export function resolveDeviceAdminRegistryPath(configuredPath?: string) {
  return resolve(configuredPath?.trim() || 'data/devices.json');
}

function describe(device: PendingDevice, index: number, isChinese: boolean) {
  const requestedAt = new Date(device.requestedAt).toISOString();
  const role = isChinese
    ? (device.role === 'client' ? '浏览器' : '连接器')
    : device.role;
  return `${index + 1}. ${role} · ${device.label} · ${device.address} · ${requestedAt}`;
}

function selectDevice(devices: PendingDevice[], selector: string) {
  const index = Number(selector);
  if (Number.isInteger(index) && index >= 1 && index <= devices.length) return devices[index - 1];
  return devices.find((device) => device.requestId === selector);
}

function describeApproved(device: ApprovedDevice, index: number, isChinese: boolean) {
  const approvedAt = new Date(device.approvedAt).toISOString();
  const role = isChinese
    ? (device.role === 'client' ? '浏览器' : '连接器')
    : device.role;
  return `${index + 1}. ${role} · ${device.label.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')} · ${approvedAt}`;
}

const timeText = (value: number | null, isChinese: boolean) => value === null ? (isChinese ? '未记录' : 'not recorded') : new Date(value).toISOString();
function describeActivity(device: ApprovedDevice, snapshot: DeviceActivitySnapshot | null, now: number, isChinese: boolean) {
  const activity = activityForDevice(snapshot, device.role, device.id, now);
  const state = isChinese ? { online: '在线', offline: '离线', unknown: '状态未知' }[activity.status] : activity.status;
  return isChinese
    ? `   ${state} · 连接数 ${activity.connections ?? '未知'} · 最近连接 ${timeText(activity.lastConnectedAt, true)} · 最后在线 ${timeText(activity.lastSeenAt, true)}`
    : `   ${state} · connections ${activity.connections ?? 'unknown'} · last connected ${timeText(activity.lastConnectedAt, false)} · last seen ${timeText(activity.lastSeenAt, false)}`;
}

async function revokeApprovedDevice({
  registry,
  args,
  operator,
  isChinese,
}: {
  registry: DeviceRegistry;
  args: string[];
  operator: DeviceAdminIo;
  isChinese: boolean;
}) {
  const devices = registry.listApproved().sort((left, right) => right.approvedAt - left.approvedAt);
  const snapshot = readDeviceActivity(deviceActivityPath(registry.filePath));
  const now = Date.now();
  if (args[0] === 'list-approved' && args.includes('--json')) {
    operator.write(JSON.stringify({ version: 1, sampledAt: snapshot?.updatedAt ?? null, activityAvailable: activityIsCurrent(snapshot, now),
      devices: devices.map((device, index) => ({ index: index + 1, id: device.id, role: device.role, label: device.label,
        ...(device.routeDeviceId ? { routeDeviceId: device.routeDeviceId } : {}), approvedAt: device.approvedAt,
        ...activityForDevice(snapshot, device.role, device.id, now) })) }, null, 2) + '\n');
    return 'listed';
  }
  if (!devices.length) {
    operator.write(isChinese ? '没有已批准设备。\n' : 'No approved devices.\n');
    return 'empty';
  }
  operator.write(`${isChinese ? '已批准设备' : 'Approved devices'}:\n${devices
    .map((device, index) => `${describeApproved(device, index, isChinese)}\n${describeActivity(device, snapshot, now, isChinese)}`).join('\n')}\n\n`);
  operator.write(isChinese
    ? '时间为 UTC。在线/最后在线反映连接与心跳，不代表用户正在操作；旧历史显示“未记录”。\n'
    : 'Times are UTC. Online/last seen reflect connections and heartbeats, not user interaction; older history is not recorded.\n');
  if (snapshot) operator.write(isChinese
    ? `状态采样：${timeText(snapshot.updatedAt, true)}${snapshot.relayState === 'stopped' ? '（Relay 已停止）' : ''}\n`
    : `Activity sampled: ${timeText(snapshot.updatedAt, false)}${snapshot.relayState === 'stopped' ? ' (Relay stopped)' : ''}\n`);
  if (!activityIsCurrent(snapshot, now)) operator.write(isChinese
    ? '活跃快照缺失或已过期，连接状态未知。请检查 Relay 是否运行并已更新。\n'
    : 'Activity snapshot is missing or stale; connection state is unknown. Check that the Relay is running and updated.\n');
  if (args[0] === 'list-approved') return 'listed';

  const argument = args[0] === 'revoke' ? args[1] : undefined;
  const index = Number(argument);
  let selected = Number.isInteger(index) && index >= 1 && index <= devices.length
    ? devices[index - 1]
    : undefined;
  if (!selected) {
    const answer = (await operator.question(isChinese
      ? `请输入要撤销的设备序号（1-${devices.length}，输入 q 退出）：`
      : `Select a device to revoke (1-${devices.length}, or q): `)).trim();
    if (/^q(?:uit)?$/i.test(answer)) return 'cancelled';
    const answerIndex = Number(answer);
    if (Number.isInteger(answerIndex) && answerIndex >= 1 && answerIndex <= devices.length) {
      selected = devices[answerIndex - 1];
    }
  }
  if (!selected) throw new Error(isChinese ? '未找到所选的已批准设备。' : 'Approved device selection was not found.');

  operator.write(`${isChinese ? '已选择' : 'Selected'}: ${describeApproved(
    selected, devices.indexOf(selected), isChinese,
  ).replace(/^\d+\. /, '')}\n`);
  const confirmed = args.includes('--yes')
    || /^(?:y|yes|是|确认)$/i.test((await operator.question(
      isChinese ? '撤销这个设备？[y/N] ' : 'Revoke this device? [y/N] ',
    )).trim());
  if (!confirmed) {
    operator.write(isChinese ? '已取消。\n' : 'Cancelled.\n');
    return 'cancelled';
  }
  if (!registry.remove(selected.role, selected.id)) {
    throw new Error(isChinese ? '该设备已被撤销。' : 'The device was already revoked.');
  }
  operator.write(isChinese
    ? `已撤销${selected.role === 'client' ? '浏览器' : '连接器'}：${selected.label}\n`
    : `Revoked ${selected.role}: ${selected.label}\n`);
  return 'revoked';
}

export async function runDeviceAdmin(options: DeviceAdminOptions = {}) {
  const {
    registryPath,
    args = process.argv.slice(2),
    io,
    language = process.env.CODEX_UI_LANGUAGE || 'en',
  } = options;
  const isChinese = language.toLowerCase().startsWith('zh');
  const registry = options.registry
    || new DeviceRegistry(resolveDeviceAdminRegistryPath(
      registryPath || process.env.BRIDGE_DEVICE_REGISTRY_FILE,
    ));
  const readline = io ? null : createInterface({ input: stdin, output: stdout });
  const operator = io || {
    question: (prompt: string) => readline!.question(prompt),
    write: (text: string) => stdout.write(text),
    close: () => readline!.close(),
  };
  try {
    if (args[0] === 'pair') {
      const publicUrl = normalizePublicUrl(args[1] || process.env.BRIDGE_PUBLIC_URL);
      const pairing = registry.createBrowserPairing();
      publicUrl.hash = browserPairingFragment(pairing.credential);
      const pairingUrl = publicUrl.toString();
      const renderQrCode = options.renderQrCode
        || ((value: string) => QRCode.toString(value, { type: 'terminal', small: true, errorCorrectionLevel: 'M' }));
      operator.write(isChinese
        ? `在 10 分钟内打开下面的单次配对链接，或扫描二维码：\n${pairingUrl}\n\n`
        : `Open this one-time pairing link within 10 minutes, or scan the QR code:\n${pairingUrl}\n\n`);
      operator.write(`${await renderQrCode(pairingUrl)}\n`);
      operator.write(isChinese
        ? '没有摄像头时可直接复制链接，或在 Web 页面上传二维码截图。\n'
        : 'Without a camera, copy the link or upload a QR screenshot on the Web page.\n');
      return 'pairing-created';
    }
    if (args[0] === 'revoke' || args[0] === 'list-approved') {
      return await revokeApprovedDevice({ registry, args, operator, isChinese });
    }
    const devices = registry.list().pending.sort((left, right) => right.requestedAt - left.requestedAt);
    if (!devices.length) {
      operator.write(isChinese
        ? '没有待批准设备。请先打开 Web 页面并尝试登录。\n'
        : 'No pending devices. Open the Web page and try signing in first.\n');
      return 'empty';
    }
    operator.write(`${isChinese ? '待批准设备' : 'Pending devices'}:\n${devices
      .map((device, index) => describe(device, index, isChinese)).join('\n')}\n\n`);
    if (args[0] === 'list') return 'listed';

    let selected: PendingDevice | undefined;
    const argument = args[0] === 'approve' ? args[1] : args[0];
    if (argument) selected = selectDevice(devices, argument);
    else if (devices.length === 1) [selected] = devices;
    else {
      const answer = (await operator.question(isChinese
        ? `请输入要批准的设备序号（1-${devices.length}，输入 q 退出）：`
        : `Select a device to approve (1-${devices.length}, or q): `)).trim();
      if (/^q(?:uit)?$/i.test(answer)) return 'cancelled';
      selected = selectDevice(devices, answer);
    }
    if (!selected) throw new Error(isChinese ? '未找到所选的待批准设备。' : 'Pending device selection was not found.');

    operator.write(`${isChinese ? '已选择' : 'Selected'}: ${describe(
      selected, devices.indexOf(selected), isChinese,
    ).replace(/^\d+\. /, '')}\n`);
    const confirmed = args.includes('--yes')
      || /^(?:y|yes|是|确认)$/i.test((await operator.question(
        isChinese ? '批准这个设备？[y/N] ' : 'Approve this device? [y/N] ',
      )).trim());
    if (!confirmed) {
      operator.write(isChinese ? '已取消。\n' : 'Cancelled.\n');
      return 'cancelled';
    }
    const approved = registry.approve(selected.requestId);
    if (!approved) {
      throw new Error(isChinese ? '该待批准设备已过期或已被处理。' : 'The pending device expired or was already handled.');
    }
    const approvedRole = isChinese
      ? (approved.role === 'client' ? '浏览器' : '连接器')
      : approved.role;
    operator.write(isChinese
      ? `已批准${approvedRole}：${approved.label}\n`
      : `Approved ${approvedRole}: ${approved.label}\n`);
    return 'approved';
  } finally {
    operator.close?.();
  }
}

function normalizePublicUrl(value: unknown) {
  let parsed: URL;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new Error('Provide the public Web URL: device-admin.js pair https://codex.example.com');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash) {
    throw new Error('The public Web URL must use http:// or https:// without credentials, query, or fragment.');
  }
  parsed.pathname = '/';
  return parsed;
}

const isEntryPoint = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntryPoint) {
  runDeviceAdmin().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
