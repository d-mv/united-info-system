export class ClockWidget extends HTMLElement {
  static manifest = {
    id: 'clock',
    type: 'widget',
    cols: 2,
    rows: 1,
    defaultCol: 1,
    defaultRow: 1,
    expandable: true,
  };

  connectedCallback() {
    this.render();
    this._tick();
    this._interval = setInterval(() => this._tick(), 1000);
  }

  disconnectedCallback() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  render() {
    this.innerHTML = `
      <p class="label">Clock</p>
      <button class="zoom-button" type="button" aria-label="Expand Clock">Expand</button>
      <div class="numeral" id="clock-time">
        <span id="clock-text">--:--:--</span>
        <span class="live-dot live-dot--pulse" aria-hidden="true"></span>
      </div>
    `;
  }

  _tick() {
    const timeEl = this.querySelector('#clock-text');
    if (timeEl) {
      timeEl.textContent = new Date().toLocaleTimeString([], { hour12: false });
    }
  }
}

if (typeof customElements !== 'undefined' && customElements.define) {
  try {
    customElements.define('widget-clock', ClockWidget);
  } catch (e) {
    // ignore re-registration error
  }
}
