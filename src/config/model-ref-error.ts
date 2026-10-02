export class ModelRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelRefError';
  }
}
