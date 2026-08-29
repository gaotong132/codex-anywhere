import { stdin, stdout } from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { DeviceRegistry, type ApprovedDevice, type PendingDevice } from './device-registry.js';

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
  return `${index + 1}. ${role} · ${device.label} · ${approvedAt}`;
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
  const devices = registry.list().approved.sort((left, right) => right.approvedAt - left.approvedAt);
  if (!devices.length) {
    operator.write(isChinese ? '没有已批准设备。\n' : 'No approved devices.\n');
    return 'empty';
  }
  operator.write(`${isChinese ? '已批准设备' : 'Approved devices'}:\n${devices
    .map((device, index) => describeApproved(device, index, isChinese)).join('\n')}\n\n`);
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

const isEntryPoint = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntryPoint) {
  runDeviceAdmin().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
