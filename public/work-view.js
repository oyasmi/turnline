const toolStatus = {
  in_progress: '进行中', completed: '完成', failed: '失败', incomplete: '未完成',
};

function elapsed(ms) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}

function replaceText(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

export class WorkView {
  constructor(element, stop) {
    this.element = element;
    this.stop = stop;
    this.summary = element.querySelector('summary');
    this.details = element.querySelector('details');
    this.activity = element.querySelector('ol');
    this.reasoning = element.querySelector('.work-reasoning');
    this.details.addEventListener('toggle', () => this.renderDetails());
  }

  render(turn, now) {
    if (this.turn !== turn) {
      this.turn = turn;
      this.details.open = false;
      this.dirty = true;
    }
    const running = turn && !turn.ended && turn.visible;
    const status = turn?.activity;
    this.element.hidden = !running && !status?.count && !status?.reasoning.size &&
      !turn?.stopping && !['cancelled', 'failed'].includes(turn?.outcome);
    this.stop.hidden = !running;
    this.stop.disabled = Boolean(turn?.stopping);
    replaceText(this.stop, turn?.stopping ? '正在停工…' : '停止工作');
    if (this.element.hidden) return;

    const tool = running ? status.running : undefined;
    const phase = running
      ? turn.stopping ? '正在确认停工' : turn.responseStatus === 'queued' ? '排队中' : '工作中'
      : { completed: '已完成', cancelled: '已停止工作', failed: '回合结束，结果待确认' }[turn.outcome] ?? '回合结束';
    const pieces = [phase, elapsed((turn.finishedAt ?? now) - (turn.workStartedAt ?? turn.startedAt))];
    if (status.count) pieces.push('工具 ' + status.count + ' 次');
    if (tool) pieces.push(tool.label);
    if (turn.replayGap) pieces.push('部分实时事件已省略');
    if (running && turn.speechSuppressed && turn.voice) pieces.push('已停播');
    replaceText(this.summary, pieces.join(' · '));
    this.renderDetails();
  }

  changed() {
    this.dirty = true;
  }

  renderDetails() {
    if (!this.details.open || !this.dirty) return;
    this.dirty = false;
    const { activity } = this.turn;
    const rows = activity.details.map(tool => {
      const row = document.createElement('li');
      const label = document.createElement('span');
      const duration = tool.ended === undefined ? '' : ' · ' + elapsed(tool.ended - tool.started);
      label.textContent = tool.label + ' · ' + (toolStatus[tool.status] ?? toolStatus.incomplete) + duration;
      row.append(label);
      if (tool.output) {
        const output = document.createElement('small');
        output.textContent = tool.output;
        row.append(output);
      }
      return row;
    });
    this.activity.replaceChildren(...rows);
    const summaries = Array.from(activity.reasoning.values()).slice(-8);
    this.reasoning.hidden = summaries.length === 0;
    replaceText(this.reasoning.querySelector('p'), summaries.join('\n\n'));
    this.activity.hidden = rows.length === 0;
  }
}
