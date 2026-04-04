/**
 * Sound Effects System for Door Hardware Tracker
 * Web Audio API-based sci-fi/industrial sounds generated programmatically
 * SSR-safe with lazy initialization and autoplay handling
 */

type SoundType =
  | "click"
  | "success"
  | "error"
  | "hover"
  | "toggle"
  | "complete"
  | "notification";

class SoundManager {
  private static instance: SoundManager;
  private audioContext: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private enabled: boolean = true;
  private masterVolume = 0.15; // Subtle, non-intrusive

  private constructor() {
    // Initialize on first user interaction
    if (typeof window !== "undefined") {
      window.addEventListener("click", () => this.ensureContext(), {
        once: true,
      });
      window.addEventListener("keydown", () => this.ensureContext(), {
        once: true,
      });
    }
  }

  static getInstance(): SoundManager {
    if (!SoundManager.instance) {
      SoundManager.instance = new SoundManager();
    }
    return SoundManager.instance;
  }

  /**
   * Ensure AudioContext exists and is initialized
   */
  private ensureContext(): void {
    if (typeof window === "undefined" || this.audioContext) {
      return;
    }

    try {
      const AudioContextClass =
        (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) {
        console.warn("Web Audio API not supported");
        return;
      }

      this.audioContext = new AudioContextClass() as AudioContext;
      if (this.audioContext!.state === "suspended") {
        this.audioContext!.resume().catch(console.error);
      }

      this.masterGain = this.audioContext!.createGain();
      this.masterGain!.gain.value = this.masterVolume;
      this.masterGain!.connect(this.audioContext!.destination);
    } catch (error) {
      console.error("Failed to initialize AudioContext:", error);
    }
  }

  /**
   * Play a short, snappy click with industrial/mechanical feel
   * Quick white noise burst with bandpass filter
   */
  playClick(): void {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.audioContext || !this.masterGain) return;

    const ctx = this.audioContext;
    const now = ctx.currentTime;
    const duration = 0.08;

    // White noise source
    const bufferSize = ctx.sampleRate * duration;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    // Bandpass filter
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 4000;
    filter.Q.value = 10;

    // Envelope
    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(0.4, now);
    gainNode.gain.exponentialRampToValueAtTime(0.01, now + duration);

    noise.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(this.masterGain!);

    noise.start(now);
    noise.stop(now + duration);
  }

  /**
   * Ascending two-tone chime - checkpoint reached in a game
   * Two sine tones: 440hz → 660hz with quick decay
   */
  playSuccess(): void {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.audioContext || !this.masterGain) return;

    const ctx = this.audioContext;
    const now = ctx.currentTime;

    // First tone: 440hz (A4)
    const osc1 = ctx.createOscillator();
    osc1.type = "sine";
    osc1.frequency.value = 440;

    const gain1 = ctx.createGain();
    gain1.gain.setValueAtTime(0.3, now);
    gain1.gain.exponentialRampToValueAtTime(0.05, now + 0.15);

    osc1.connect(gain1);
    gain1.connect(this.masterGain!);

    osc1.start(now);
    osc1.stop(now + 0.15);

    // Second tone: 660hz (E5), slightly delayed
    const osc2 = ctx.createOscillator();
    osc2.type = "sine";
    osc2.frequency.value = 660;

    const gain2 = ctx.createGain();
    gain2.gain.setValueAtTime(0.3, now + 0.08);
    gain2.gain.exponentialRampToValueAtTime(0.05, now + 0.23);

    osc2.connect(gain2);
    gain2.connect(this.masterGain!);

    osc2.start(now + 0.08);
    osc2.stop(now + 0.23);
  }

  /**
   * Low buzzer with descending tone and distortion feel
   * 200hz → 100hz with short duration
   */
  playError(): void {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.audioContext || !this.masterGain) return;

    const ctx = this.audioContext;
    const now = ctx.currentTime;
    const duration = 0.25;

    const osc = ctx.createOscillator();
    osc.type = "square"; // Harsh square wave for "error" feel
    osc.frequency.setValueAtTime(200, now);
    osc.frequency.exponentialRampToValueAtTime(100, now + duration);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.25, now);
    gain.gain.exponentialRampToValueAtTime(0.02, now + duration);

    osc.connect(gain);
    gain.connect(this.masterGain!);

    osc.start(now);
    osc.stop(now + duration);
  }

  /**
   * Very subtle, barely audible tick
   * Ultra-short sine blip at 800hz, very low volume
   */
  playHover(): void {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.audioContext || !this.masterGain) return;

    const ctx = this.audioContext;
    const now = ctx.currentTime;
    const duration = 0.04;

    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 800;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.08, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + duration);

    osc.connect(gain);
    gain.connect(this.masterGain!);

    osc.start(now);
    osc.stop(now + duration);
  }

  /**
   * Switch flip sound - short noise burst with high-pass filter
   */
  playToggle(): void {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.audioContext || !this.masterGain) return;

    const ctx = this.audioContext;
    const now = ctx.currentTime;
    const duration = 0.12;

    // White noise source
    const bufferSize = ctx.sampleRate * duration;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    // High-pass filter for "switch" character
    const filter = ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = 5000;
    filter.Q.value = 2;

    // Envelope with quick attack and decay
    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(0.35, now + 0.02);
    gainNode.gain.exponentialRampToValueAtTime(0.02, now + duration);

    noise.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(this.masterGain!);

    noise.start(now);
    noise.stop(now + duration);
  }

  /**
   * Victory fanfare - three ascending tones with reverb/delay feel
   * C5→E5→G5 with overlapping tones and decay
   */
  playComplete(): void {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.audioContext || !this.masterGain) return;

    const ctx = this.audioContext;
    const now = ctx.currentTime;

    // Frequencies: C5=523.25Hz, E5=659.25Hz, G5=783.99Hz
    const frequencies = [523.25, 659.25, 783.99];
    const startTimes = [0, 0.15, 0.3];
    const duration = 0.5;

    frequencies.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;

      const gain = ctx.createGain();
      const startTime = now + startTimes[idx];
      gain.gain.setValueAtTime(0.35, startTime);
      gain.gain.exponentialRampToValueAtTime(0.02, startTime + duration);

      osc.connect(gain);
      gain.connect(this.masterGain!);

      osc.start(startTime);
      osc.stop(startTime + duration);
    });
  }

  /**
   * Two-note alert chime - Borderlands-style notification ping
   */
  playNotification(): void {
    if (!this.enabled) return;
    this.ensureContext();
    if (!this.audioContext || !this.masterGain) return;

    const ctx = this.audioContext;
    const now = ctx.currentTime;

    // First note: 600hz
    const osc1 = ctx.createOscillator();
    osc1.type = "sine";
    osc1.frequency.value = 600;

    const gain1 = ctx.createGain();
    gain1.gain.setValueAtTime(0.25, now);
    gain1.gain.exponentialRampToValueAtTime(0.02, now + 0.12);

    osc1.connect(gain1);
    gain1.connect(this.masterGain!);

    osc1.start(now);
    osc1.stop(now + 0.12);

    // Second note: 800hz, slightly delayed and higher pitch
    const osc2 = ctx.createOscillator();
    osc2.type = "sine";
    osc2.frequency.value = 800;

    const gain2 = ctx.createGain();
    gain2.gain.setValueAtTime(0.25, now + 0.1);
    gain2.gain.exponentialRampToValueAtTime(0.02, now + 0.22);

    osc2.connect(gain2);
    gain2.connect(this.masterGain!);

    osc2.start(now + 0.1);
    osc2.stop(now + 0.22);
  }

  /**
   * Generic sound player
   */
  play(soundType: SoundType): void {
    switch (soundType) {
      case "click":
        this.playClick();
        break;
      case "success":
        this.playSuccess();
        break;
      case "error":
        this.playError();
        break;
      case "hover":
        this.playHover();
        break;
      case "toggle":
        this.playToggle();
        break;
      case "complete":
        this.playComplete();
        break;
      case "notification":
        this.playNotification();
        break;
    }
  }

  /**
   * User preference management
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  toggle(): void {
    this.enabled = !this.enabled;
  }
}

// Export singleton instance
export const sounds = SoundManager.getInstance();

// Export individual convenience functions
export const playClick = () => sounds.playClick();
export const playSuccess = () => sounds.playSuccess();
export const playError = () => sounds.playError();
export const playHover = () => sounds.playHover();
export const playToggle = () => sounds.playToggle();
export const playComplete = () => sounds.playComplete();
export const playNotification = () => sounds.playNotification();

// Export types
export type { SoundType };
export { SoundManager };
