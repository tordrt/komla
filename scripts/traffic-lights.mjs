/**
 * The macOS traffic lights, in window coordinates. They are OS chrome that neither a screencast
 * nor a page screenshot captures, so the landing videos and the README's hero draw them.
 * Matches window.service.ts trafficLightPosition and the 12px / 20px macOS spacing.
 */
export const TRAFFIC_LIGHTS = {
  x: 21,
  y: 18,
  gap: 20,
  radius: 6,
  colors: ['#ff5f57', '#febc2e', '#28c840'],
};
