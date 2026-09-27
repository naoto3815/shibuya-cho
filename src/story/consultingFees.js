const REASONS = [
  '戦力差のアドバイザリー料',
  '身の程を知る市場調査費',
  '拳によるリスク管理研修費',
  '威圧的コミュニケーションの改善指導料',
  '無謀な事業計画の見直し相談料',
];

export class ConsultingFees {
  constructor() { this.begin(null); }
  begin(context) {
    this.context = context;
    this.seen = new WeakSet();
    this.items = [];
  }
  collect(target, context, roll) {
    if (!target || target.kind !== 'enemy' || this.seen.has(target)) return null;
    this.seen.add(target);
    if (context === 'club') return { amount: 0, reason: '誤解による衝突につき相談料なし' };
    const reason = context === 'host' || context === 'tout'
      ? '戦力差を知るリスク管理アドバイザリー料'
      : REASONS[this.items.length % REASONS.length];
    const fee = { amount: Math.round(roll() / 10) * 10, reason };
    this.items.push(fee);
    return fee;
  }
  summary() {
    if (this.context === 'club') return '誤解による衝突のため、コンサル報酬は受け取らない。';
    return this.items.map(f => `${f.reason}  ¥${f.amount.toLocaleString('ja-JP')}`).join('\n');
  }
}
