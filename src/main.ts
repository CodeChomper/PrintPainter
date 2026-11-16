import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { registerSW } from 'virtual:pwa-register';
import App from './app/App.vue';
import { useUiStore } from './app/stores/ui';
import '@fontsource/archivo-black/400.css';
import '@fontsource/space-grotesk/400.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/700.css';
import './app/styles.css';

const app = createApp(App);
app.use(createPinia());
app.mount('#app');

const ui = useUiStore();
const updateSW = registerSW({
  onNeedRefresh: () => ui.setUpdateHandler(() => void updateSW(true)),
});
