// Loaded in the head of app.html, before the stylesheets, so the theme is on the root
// element by the first paint. Everything else about themes is in lib/theme.js.
import { applyTheme } from '../lib/theme.js';

applyTheme();
