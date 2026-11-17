<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useSpaceMouseStore } from '../stores/spaceMouse';

const sm = useSpaceMouseStore();
const dialog = ref<HTMLDialogElement>();

// Not modal, so the view stays usable (and visible) while you tune the settings.
watch(
  () => sm.dialogOpen,
  (open) => (open ? dialog.value?.show() : dialog.value?.close()),
);

const speedExp = computed({
  get: () => Math.log2(sm.settings.speed),
  set: (v: number) => (sm.settings.speed = Math.round(2 ** v * 100) / 100),
});

const AXES = [
  ['tx', 'Left / right'],
  ['ty', 'Forward / back'],
  ['tz', 'Up / down'],
  ['rx', 'Tilt'],
  ['ry', 'Roll (unused)'],
  ['rz', 'Twist'],
] as const;
const bar = (v: number) => {
  const f = Math.max(-1, Math.min(1, v / 350));
  return { left: `${50 + Math.min(0, f) * 50}%`, width: `${Math.abs(f) * 50}%` };
};

const INVERTS = [
  ['invertPanX', 'Pan left / right'],
  ['invertPanY', 'Pan up / down'],
  ['invertZoom', 'Zoom'],
  ['invertTilt', 'Tilt'],
  ['invertSpin', 'Twist'],
] as const;
</script>

<template>
  <dialog ref="dialog" class="sm" aria-labelledby="sm-title" @close="sm.dialogOpen = false" @keydown.esc.stop="sm.dialogOpen = false">
    <header>
      <h2 id="sm-title">SpaceMouse</h2>
      <button class="icon-btn" title="Close" aria-label="Close" @click="sm.dialogOpen = false">×</button>
    </header>

    <template v-if="!sm.supported">
      <p>This browser can't talk to USB devices. Use Chrome or Edge on a desktop to use a 3Dconnexion SpaceMouse.</p>
    </template>
    <template v-else>
      <div class="status">
        <span class="led" :class="{ on: sm.connected }" />
        <span v-if="sm.connected">Connected: <strong>{{ sm.connected }}</strong></span>
        <span v-else class="muted">Not connected</span>
        <span class="grow" />
        <button v-if="sm.connected" class="btn" @click="sm.disconnect()">Disconnect</button>
        <button v-else class="btn btn-accent" @click="sm.connect()">Connect…</button>
      </div>
      <p v-if="sm.error" class="error">{{ sm.error }}</p>
      <p v-if="!sm.connected" class="hint">Plug it in, click Connect and pick it in the list. The browser remembers it next time.</p>

      <h4>Feel</h4>
      <label class="slider">
        <span>Speed</span>
        <input v-model.number="speedExp" type="range" name="smSpeed" min="-2" max="2" step="0.05" />
        <output>{{ sm.settings.speed.toFixed(2) }}×</output>
      </label>
      <label class="check"><input v-model="sm.settings.lockRotation" type="checkbox" name="smLockRotation" /> Lock rotation (pan and zoom only)</label>
      <label class="check"><input v-model="sm.settings.zoomUpDown" type="checkbox" name="smZoomUpDown" /> Zoom by pushing down / pulling up</label>
      <p class="hint">You move the cap as if holding the model. The view turns around the point at the centre of the screen.</p>

      <h4>Reverse</h4>
      <div class="inverts">
        <label v-for="[k, label] in INVERTS" :key="k" class="check">
          <input v-model="sm.settings[k]" type="checkbox" :name="k" /> {{ label }}
        </label>
      </div>

      <h4>Live input</h4>
      <ul class="axes">
        <li v-for="[k, label] in AXES" :key="k">
          <span>{{ label }}</span>
          <span class="track"><span class="fill" :style="bar(sm.live[k])" /></span>
          <output>{{ sm.live[k] }}</output>
        </li>
      </ul>
      <p class="hint">
        Last button: <strong>{{ sm.lastButton === null ? 'none yet' : `#${sm.lastButton}` }}</strong>
      </p>

      <h4>Buttons</h4>
      <dl class="buttons">
        <dt>Fit</dt><dd>Fit view</dd>
        <dt>T / F / R</dt><dd>Top, front and right views</dd>
        <dt>Roll</dt><dd>Turn the view 90°</dd>
        <dt>1–4</dt><dd>Filaments 1 to 4</dd>
        <dt>Esc</dt><dd>Same as the Esc key</dd>
        <dt>Rotation</dt><dd>Lock or unlock rotation</dd>
        <dt>Menu</dt><dd>Open or close this panel</dd>
      </dl>

      <div class="actions">
        <button class="btn" @click="sm.resetSettings()">Reset settings</button>
      </div>
    </template>
  </dialog>
</template>

<style scoped>
.sm {
  position: fixed;
  inset: 3.25rem 1rem auto auto;
  margin: 0;
  width: min(22rem, calc(100vw - 2rem));
  max-height: calc(100dvh - 5rem);
  overflow: auto;
  border: 1px solid var(--border);
  border-top: 4px solid var(--accent);
  background: var(--panel);
  color: var(--text);
  padding: 0.9rem 1rem 1rem;
  box-shadow: 0 12px 32px rgb(0 0 0 / 0.5);
  z-index: 30;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
h2 {
  margin: 0;
  font-size: 1rem;
}
h4 {
  margin: 1rem 0 0.45rem;
}
p {
  margin: 0.5rem 0 0;
  line-height: 1.45;
}
.icon-btn {
  border: none;
  background: none;
  color: var(--muted);
  font-size: 1.3rem;
  line-height: 1;
  cursor: pointer;
}
.icon-btn:hover {
  color: var(--text);
}
.status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.75rem;
}
.grow {
  flex: 1;
}
.led {
  width: 8px;
  height: 8px;
  background: var(--border-strong);
  flex: none;
}
.led.on {
  background: var(--accent);
}
.muted {
  color: var(--muted);
}
.hint {
  color: var(--muted);
  font-size: 0.8rem;
}
.error {
  color: var(--danger);
  font-size: 0.85rem;
}
.slider {
  display: grid;
  grid-template-columns: auto 1fr 3.2rem;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
}
.slider span {
  color: var(--muted);
}
.slider input {
  min-width: 0;
}
.slider output {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.check {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.4rem;
  font-size: 0.85rem;
}
.inverts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 0.5rem;
}
.inverts .check {
  margin-top: 0.25rem;
}
.axes {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.3rem;
  font-size: 0.8rem;
}
.axes li {
  display: grid;
  grid-template-columns: 6.5rem 1fr 2.6rem;
  align-items: center;
  gap: 0.5rem;
}
.axes li > span:first-child {
  color: var(--muted);
}
.track {
  position: relative;
  height: 8px;
  background: var(--panel-raised);
  border: 1px solid var(--border);
}
.track::after {
  content: '';
  position: absolute;
  left: 50%;
  top: -2px;
  bottom: -2px;
  width: 1px;
  background: var(--border-strong);
}
.fill {
  position: absolute;
  top: 0;
  bottom: 0;
  background: var(--accent);
}
.axes output {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.buttons {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.2rem 0.75rem;
  margin: 0;
  font-size: 0.82rem;
}
.buttons dt {
  font-family: var(--font-display);
  font-size: 0.68rem;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: var(--muted);
  align-self: center;
}
.buttons dd {
  margin: 0;
}
.actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 1rem;
}
</style>
