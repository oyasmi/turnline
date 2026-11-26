const LABELS = new Map(Object.entries({
  bash: '正在执行命令', read: '正在读取文件', write: '正在写入文件', edit: '正在编辑文件',
  grep: '正在检索内容', glob: '正在查找文件', find: '正在查找文件',
  web_search: '正在搜索网页', web_fetch: '正在读取网页', send_media: '正在发送文件',
  memory_manage: '正在管理记忆', memory_save: '正在保存记忆', memory_search: '正在检索记忆',
  memory_forget: '正在删除记忆', session_search: '正在搜索历史', skill: '正在查找技能',
  event_manage: '正在管理事件', job: '正在管理后台作业', subagent: '正在委派子任务',
  subagent_inline: '正在委派子任务', subagent_list: '正在查看委派列表', subagent_run: '正在管理委派任务',
  task_list: '正在查看任务', task_create: '正在创建任务', task_close: '正在关闭任务',
  task_log: '正在读取任务日志', task_message: '正在给任务发消息', task_pause: '正在暂停任务',
  task_resume: '正在恢复任务', task_report: '正在汇报任务', task_ask: '正在请求决定', task_wait: '正在安排等待',
}));

const ARGUMENTS = new Map(Object.entries({
  bash: ['command', 'cmd'], read: ['path'], write: ['path'], edit: ['path'], send_media: ['path'],
  glob: ['pattern', 'path'], grep: ['pattern', 'path'], find: ['pattern', 'path'], web_search: ['query'],
  session_search: ['query'], memory_search: ['query'], memory_forget: ['name'],
  skill: ['action', 'name'], event_manage: ['action', 'name'], job: ['op'],
  subagent: ['agent', 'task'], subagent_inline: ['agent', 'task'],
  subagent_run: ['op', 'runId'], task_create: ['id'], task_close: ['id', 'outcome'], task_log: ['id'],
  task_message: ['id'], task_pause: ['id'], task_resume: ['id'], task_wait: ['until'],
}));

function clip(value, limit) {
  if (typeof value !== 'string') return '';
  return value.length > limit ? value.slice(0, limit) + '…' : value;
}

function preview(value) {
  return clip(clip(value, 240).split(/\r?\n/u, 1)[0].trim(), 72);
}

export function describeTool(name, raw) {
  const label = LABELS.get(name) ?? (name ? '正在调用工具' : '正在查询');
  let args = raw;
  if (typeof raw === 'string') {
    try { args = JSON.parse(raw); } catch { return label; }
  }
  if (!args || typeof args !== 'object') return label;
  let detail = (ARGUMENTS.get(name) ?? []).map(key => preview(args[key])).filter(Boolean).join(' · ');
  if (name === 'web_fetch' && typeof args.url === 'string') {
    try {
      const { host, pathname } = new URL(args.url);
      detail = preview(host + pathname);
    } catch {}
  }
  return detail ? label + ' · ' + detail : label;
}

export class WorkActivity {
  tools = new Map();
  reasoning = new Map();
  count = 0;

  tool(key, item, now) {
    let record = this.tools.get(key);
    if (!record) {
      record = { number: ++this.count, started: now, status: 'in_progress' };
      this.tools.set(key, record);
    }
    record.name = item.name ?? record.name;
    if (item.arguments !== undefined) record.label = describeTool(record.name, item.arguments);
    record.label ??= describeTool(record.name);
    record.status = item.status ?? record.status;
    if (record.status !== 'in_progress') record.ended ??= now;
    record.output = clip(item.pipiclaw_failure || item.output || item.error?.content, 360) || record.output;
    return record;
  }

  summary(key, text) {
    if (text?.trim()) this.reasoning.set(key, clip(text.trim(), 1600));
  }

  finish(now) {
    for (const record of this.tools.values()) {
      if (record.status === 'in_progress') {
        record.status = 'incomplete';
        record.ended = now;
      }
    }
  }

  get running() {
    let record;
    for (const entry of this.tools.values()) {
      if (entry.status === 'in_progress') record = entry;
    }
    return record;
  }

  get details() {
    return Array.from(this.tools.values()).slice(-40);
  }
}
