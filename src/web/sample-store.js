export class SampleStore {
  constructor(maxLength) {
    this.maxLength = maxLength;
    this.samples = [];
  }

  add(sample) {
    this.samples.push(sample);
    if (this.samples.length > this.maxLength) {
      this.samples.splice(0, this.samples.length - this.maxLength);
    }
  }

  latest() {
    return this.samples.at(-1) || null;
  }

  snapshot() {
    return [...this.samples];
  }

  clear() {
    this.samples = [];
  }
}
