import {
  activityLocalDay,
  addDaysStr,
  buildRecentContextBlock,
  formatRecentContextBlock,
} from '@/app/lib/coach-context';
import type { Activity } from '@/app/lib/types';

const mockGetActivities = jest.fn();
const mockGetTrainingLoads = jest.fn();

jest.mock('@/app/lib/db', () => ({
  getActivities: (...args: unknown[]) =>
    (mockGetActivities as (...a: unknown[]) => unknown)(...args),
  getTrainingLoads: (...args: unknown[]) =>
    (mockGetTrainingLoads as (...a: unknown[]) => unknown)(...args),
}));

function fakeActivity(over: Partial<Activity> = {}): Activity {
  return {
    activity_id: 7,
    name: '测试跑',
    activity_type: '跑步',
    start_time: '2026-09-12T11:08:31.000Z',
    start_time_local: '2026-09-12T19:08:31',
    distance: 16.18,
    duration: 6425,
    moving_time: 6089,
    elapsed_time: 6425,
    average_pace: 396.97,
    average_heart_rate: 137,
    training_load: 143,
    ...over,
  } as Activity;
}

describe('addDaysStr', () => {
  test('跨月回退', () => {
    expect(addDaysStr('2026-09-12', -7)).toBe('2026-09-05');
    expect(addDaysStr('2026-09-01', -1)).toBe('2026-08-31');
    expect(addDaysStr('2026-09-12', -120)).toBe('2026-05-15');
  });
});

describe('activityLocalDay', () => {
  test('取本地日期，缺失回退', () => {
    expect(activityLocalDay(fakeActivity())).toBe('2026-09-12');
    const a = fakeActivity({ start_time_local: '' });
    expect(activityLocalDay(a)).toBe('2026-09-12');
  });
});

describe('formatRecentContextBlock', () => {
  test('完整上下文格式化', () => {
    const s = formatRecentContextBlock({
      sevenDayKm: 32.56,
      sevenDayCount: 3,
      tsb: 5.4,
      tsbLabel: '平衡',
      prevDate: '09-10',
      prevName: '两江新区 - 基础训练',
      prevKm: 11.25131,
      prevPace: '5:49',
    });
    expect(s).toContain('近7天: 32.6 km / 3 次');
    expect(s).toContain('当日TSB: +5（平衡）');
    expect(s).toContain('上次跑步: 09-10 两江新区 - 基础训练 11.25 km 配速 5:49');
  });

  test('负 TSB 带符号', () => {
    const s = formatRecentContextBlock({
      sevenDayKm: 0,
      sevenDayCount: 0,
      tsb: -25.2,
      tsbLabel: '疲劳',
      prevDate: null,
      prevName: null,
      prevKm: null,
      prevPace: null,
    });
    expect(s).toContain('当日TSB: -25（疲劳）');
    expect(s).not.toContain('上次跑步');
  });
});

describe('buildRecentContextBlock', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('组装7天跑量（排除本次）+上次跑步+TSB', () => {
    mockGetActivities
      .mockReturnValueOnce({
        // 近7天窗口（含本次，需排除）
        data: [
          { activity_id: 7, distance: 16.18 },
          { activity_id: 6, distance: 11.25 },
          { activity_id: 5, distance: 7.21 },
        ],
      })
      .mockReturnValueOnce({
        // 上次跑步查询（第一条非本次）
        data: [
          { activity_id: 7, distance: 16.18 },
          {
            activity_id: 6,
            name: '两江新区 - 基础训练',
            start_time: '2026-09-10T10:33:50.000Z',
            start_time_local: '2026-09-10T18:33:50',
            distance: 11.25,
            average_pace: 348.9,
          },
        ],
      });
    mockGetTrainingLoads.mockReturnValue([
      { date: '2026-09-12', load: 143, distance: 16180, duration: 6089 },
    ]);

    const s = buildRecentContextBlock(fakeActivity());
    expect(s).toContain('近7天: 18.5 km / 2 次');
    expect(s).toContain('上次跑步: 09-10 两江新区 - 基础训练 11.25 km');
  });

  test('DB异常时返回空串不抛错', () => {
    mockGetActivities.mockImplementation(() => {
      throw new Error('db gone');
    });
    expect(buildRecentContextBlock(fakeActivity())).toBe('');
  });

  test('无本地日期时返回空串', () => {
    const a = fakeActivity({ start_time_local: '', start_time: '' });
    expect(buildRecentContextBlock(a)).toBe('');
  });
});
