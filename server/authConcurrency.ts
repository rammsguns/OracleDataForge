/** Bound work before it reaches scrypt's worker queue; excess requests are never queued. */
export class AuthConcurrency {
  private total = 0;
  private readonly byAddress = new Map<string, number>();

  constructor(private readonly globalLimit = 8, private readonly addressLimit = 4) {}

  run<T>(address: string, verify: () => Promise<T>): Promise<T> | null {
    const count = this.byAddress.get(address) ?? 0;
    if (this.total >= this.globalLimit || count >= this.addressLimit) return null;
    this.total++;
    this.byAddress.set(address, count + 1);
    // Reserve synchronously, including before verify starts. Release only when work settles,
    // not when the client disconnects: disconnecting cannot cancel a running scrypt call.
    return Promise.resolve().then(verify).finally(() => {
      this.total--;
      const remaining = this.byAddress.get(address)! - 1;
      if (remaining === 0) this.byAddress.delete(address);
      else this.byAddress.set(address, remaining);
    });
  }
}
