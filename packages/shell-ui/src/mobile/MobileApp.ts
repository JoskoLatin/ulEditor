/**
 * Where `main.tsx` enters the phone's own shell (ADR 0009, "Entering the mobile
 * shell"). The shell itself is `common/MobileApp.tsx`; this name stays put
 * while the interfaces come in beside it under `ui/`.
 */
export { MobileApp } from './common/MobileApp.js';
