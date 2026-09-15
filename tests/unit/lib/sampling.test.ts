/**
 * sampling.ts 单测 — 逐秒记录降采样。
 * 关键: 自动放大步长时**强制含首末点**(保尾部极值如冲刺/最大心率), truncated 标志。
 */
import { downsampleRecords } from '@/app/lib/sampling';

describe('sampling', () => {
  test('空记录返回空 + 默认值', () => {
    const r = downsampleRecords([], 1, 100);
    expect(r).toEqual({ records: [], total_original: 0, sampled: 0, step: 1, truncated: false });
  });

  test('step=1 原样返回', () => {
    const recs = [1, 2, 3, 4, 5];
    const r = downsampleRecords(recs, 1, 100);
    expect(r.records).toEqual(recs);
    expect(r.step).toBe(1);
    expect(r.truncated).toBe(false);
    expect(r.sampled).toBe(5);
    expect(r.total_original).toBe(5);
  });

  test('samplingInterval>1 按步长抽样(含首末点)', () => {
    const recs = [0, 1, 2, 3, 4, 5, 6, 7];
    const r = downsampleRecords(recs, 2, 100);
    // 索引 0,2,4,6 + 强制末点 7
    expect(r.records).toEqual([0, 2, 4, 6, 7]);
    expect(r.step).toBe(2);
    expect(r.truncated).toBe(false);
  });

  test('超 maxPoints 自动放大步长(truncated=true)', () => {
    const recs = Array.from({ length: 1000 }, (_, i) => i);
    const r = downsampleRecords(recs, 1, 100);
    expect(r.truncated).toBe(true);
    expect(r.step).toBe(Math.ceil(1000 / 100)); // 10
    expect(r.sampled).toBeLessThanOrEqual(101); // 抽样 + 可能补末点
  });

  test('强制包含首末点(尾部极值不丢)', () => {
    const recs = Array.from({ length: 1000 }, (_, i) => i);
    const r = downsampleRecords(recs, 1, 100);
    expect(r.records[0]).toBe(0);            // 首点
    expect(r.records[r.records.length - 1]).toBe(999); // 末点
  });

  test('total_original/sampled 计数正确', () => {
    const recs = Array.from({ length: 500 }, (_, i) => i);
    const r = downsampleRecords(recs, 1, 50);
    expect(r.total_original).toBe(500);
    expect(r.sampled).toBe(r.records.length);
  });

  test('samplingInterval 为 0/负 时按下界 1 处理', () => {
    const recs = [1, 2, 3];
    expect(downsampleRecords(recs, 0, 100).step).toBe(1);
    expect(downsampleRecords(recs, -5, 100).step).toBe(1);
  });

  test('对象记录同样适用(泛型 T)', () => {
    const recs = [{ hr: 100 }, { hr: 110 }, { hr: 120 }, { hr: 130 }];
    const r = downsampleRecords(recs, 2, 100);
    // 索引 0,2 + 强制末点 3
    expect(r.records).toEqual([{ hr: 100 }, { hr: 120 }, { hr: 130 }]);
  });

  test('恰好等于 maxPoints 不触发 truncated', () => {
    const recs = Array.from({ length: 100 }, (_, i) => i);
    const r = downsampleRecords(recs, 1, 100);
    expect(r.truncated).toBe(false); // ceil(100/1)=100 不 > 100
  });
});
