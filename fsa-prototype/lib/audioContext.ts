declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

export function getAudioContextClass(): typeof AudioContext {
  return window.AudioContext || window.webkitAudioContext!;
}
