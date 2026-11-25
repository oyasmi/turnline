export class WaitingFeedback {
  constructor(show, pulse, stopTone) {
    this.show = show;
    this.pulse = pulse;
    this.stopTone = stopTone;
  }

  start() {
    this.stop();
    this.active = true;
    this.visualTimer = setTimeout(() => this.update(1), 600);
    this.soundTimer = setTimeout(() => {
      this.update(2);
      this.pulse();
      this.repeat = setInterval(this.pulse, 1200);
    }, 1200);
    this.longTimer = setTimeout(() => this.update(3), 2500);
  }

  update(stage = this.stage, tool = this.tool, toolLabel = this.toolLabel) {
    this.stage = stage;
    this.tool = tool;
    this.toolLabel = tool ? toolLabel : undefined;
    if (this.active) this.show(this.stage, this.tool, this.toolLabel);
  }

  stop() {
    clearTimeout(this.visualTimer);
    clearTimeout(this.soundTimer);
    clearTimeout(this.longTimer);
    clearInterval(this.repeat);
    this.active = false;
    this.stage = 0;
    this.tool = false;
    this.toolLabel = undefined;
    this.stopTone();
    this.show(0, false, undefined);
  }
}
