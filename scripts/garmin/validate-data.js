#!/usr/bin/env node
/**
 * Data validation script for Garmin activities database
 * Validates data consistency between FIT file parsing and database storage
 */

const Database = require('better-sqlite3');
const path = require('path');
const DatabaseManager = require('../common/db-manager');

/**
 * 人类瞬时速度合理上限 (km/h)。跑步世界纪录约 44 km/h, 球类挥拍/击球峰值也在此量级;
 * 超过它几乎必然是单位错 (m/s 当 km/h) 或解析异常。
 */
const MAX_SPEED_KMH_PLAUSIBLE = 60;

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

class DataValidator {
  constructor(dbPath = 'app/data/activities.db') {
    this.dbPath = path.resolve(dbPath);
    this.db = new Database(this.dbPath, { readonly: true });
    this.issues = [];
    this.warnings = [];
  }

  addIssue(category, message) {
    this.issues.push({ category, message });
  }

  addWarning(category, message) {
    this.warnings.push({ category, message });
  }

  async validate() {
    log('\n╔═══════════════════════════════════════════════════════╗', 'blue');
    log('║        数据验证报告                                    ║', 'blue');
    log('║        Data Validation Report                         ║', 'blue');
    log('╚═══════════════════════════════════════════════════════╝\n', 'blue');

    // Get basic stats
    const activityCount = this.db.prepare('SELECT COUNT(*) as count FROM activities').get().count;
    const lapCount = this.db.prepare('SELECT COUNT(*) as count FROM activity_laps').get().count;
    log(`总活动数: ${activityCount}`, 'cyan');
    log(`总分段数: ${lapCount}\n`, 'cyan');

    // Phase 1: Unit and calculation validation
    log('═══════════════════════════════════════════════════════', 'bright');
    log('Phase 1: 单位和计算正确性验证', 'bright');
    log('═══════════════════════════════════════════════════════\n', 'bright');

    this.validateActivityUnits();
    this.validateActivityCalculations();
    this.validateLapUnits();
    this.validateLapCalculations();

    // Phase 2: Data integrity validation
    log('\n═══════════════════════════════════════════════════════', 'bright');
    log('Phase 2: 数据完整性验证', 'bright');
    log('═══════════════════════════════════════════════════════\n', 'bright');

    this.validateNullValues();
    this.validateDataRanges();
    this.validateRelationships();
    this.validateHrZoneScope();
    this.validateSchemaDrift();

    // Summary
    this.printSummary();
  }

  validateActivityUnits() {
    log('1. Activities 表单位验证', 'cyan');

    // Check distance unit (km vs m)
    const activities = this.db.prepare(`
      SELECT activity_id, distance, duration, average_speed, average_pace
      FROM activities
      WHERE distance > 0 AND duration > 0
      LIMIT 100
    `).all();

    let distanceUnitIssues = 0;
    activities.forEach(act => {
      // average_speed 为 km/h, **distance 为公里**（DB 契约, 见 db-manager）。
      // 旧写法把 distance 当米算出 (distance/duration)*3.6, 对真实库 100/100 条
      // 全部误判为「单位不一致」—— 校验脚本自己就是错的, 每次运行都在报假警。
      const expectedSpeed = (act.distance / (act.duration / 3600));
      const diff = Math.abs(expectedSpeed - act.average_speed);

      if (diff > 0.01) {
        distanceUnitIssues++;
      }
    });

    if (distanceUnitIssues === 0) {
      log('  ✓ average_speed 与 distance 一致 (km/h, 验证通过)', 'green');
    } else {
      log(`  ✗ distance 单位问题: ${distanceUnitIssues} 条记录异常`, 'red');
      this.addIssue('单位', `Activities.distance 单位不一致，${distanceUnitIssues} 条记录`);
    }

    // max_speed 与 average_speed 同为 **km/h**（FIT 解析器 speedUnit:'km/h' 原样落库）。
    // 旧注释/阈值按 m/s（>20 视为异常），而真实库最大值 28.75 是 28.75km/h = 8m/s，
    // 完全正常 —— 阈值按 m/s 会让每条速度快的跑步都误报。
    const maxSpeedStats = this.db.prepare(`
      SELECT
        MIN(max_speed) as min_val,
        MAX(max_speed) as max_val,
        AVG(max_speed) as avg_val,
        COUNT(*) as count
      FROM activities
      WHERE max_speed IS NOT NULL
    `).get();

    if (maxSpeedStats.count > 0) {
      log(`  ✓ max_speed 范围: ${maxSpeedStats.min_val.toFixed(2)} - ${maxSpeedStats.max_val.toFixed(2)} km/h (平均: ${maxSpeedStats.avg_val.toFixed(2)})`, 'green');

      // 人类跑步/球类瞬时速度上限约 45 km/h；超过说明单位或解析有误。
      if (maxSpeedStats.max_val > MAX_SPEED_KMH_PLAUSIBLE) {
        this.addWarning('单位', `max_speed 最大值 ${maxSpeedStats.max_val.toFixed(2)} km/h 超出合理范围`);
      }
    }
  }

  validateActivityCalculations() {
    log('\n2. Activities 表计算验证', 'cyan');

    const activities = this.db.prepare(`
      SELECT
        activity_id, distance, duration, elapsed_time, moving_time,
        average_speed, average_pace
      FROM activities
      WHERE distance > 0 AND duration > 0
    `).all();

    let speedErrors = 0;
    let paceErrors = 0;
    let timeErrors = 0;

    activities.forEach(act => {
      // average_speed (km/h) = distance(km) / duration(h) = distance / (duration/3600)
      // 旧写法按「distance 是米」算 (distance/duration)*3.6, 对真实库 100/100 全误判。
      const expectedSpeed = act.distance / (act.duration / 3600);
      if (Math.abs(expectedSpeed - act.average_speed) > 0.01) {
        speedErrors++;
      }

      // average_pace 秒/公里 = duration / distance(km)
      // 旧写法再乘 1000 (当 distance 是米), 同样 100/100 全误判。
      const expectedPace = act.duration / act.distance;
      if (Math.abs(expectedPace - act.average_pace) > 0.01) {
        paceErrors++;
      }

      // Validate time relationships
      if (act.elapsed_time < act.moving_time) {
        timeErrors++;
      }
    });

    if (speedErrors === 0) {
      log(`  ✓ average_speed 计算: ${activities.length}/${activities.length} 正确`, 'green');
    } else {
      log(`  ✗ average_speed 计算错误: ${speedErrors}/${activities.length}`, 'red');
      this.addIssue('计算', `average_speed 计算错误 ${speedErrors} 条`);
    }

    if (paceErrors === 0) {
      log(`  ✓ average_pace 计算: ${activities.length}/${activities.length} 正确`, 'green');
    } else {
      log(`  ✗ average_pace 计算错误: ${paceErrors}/${activities.length}`, 'red');
      this.addIssue('计算', `average_pace 计算错误 ${paceErrors} 条`);
    }

    if (timeErrors === 0) {
      log(`  ✓ 时间关系验证: 通过`, 'green');
    } else {
      log(`  ⚠ elapsed_time < moving_time: ${timeErrors} 条记录`, 'yellow');
      this.addWarning('数据一致性', `${timeErrors} 条记录的 elapsed_time < moving_time`);
    }
  }

  validateLapUnits() {
    log('\n3. Activity_laps 表单位验证', 'cyan');

    const laps = this.db.prepare(`
      SELECT lap_index, distance, duration, average_speed, average_pace
      FROM activity_laps
      WHERE distance > 0 AND duration > 0
      LIMIT 100
    `).all();

    if (laps.length === 0) {
      log('  ⚠ 没有分段数据', 'yellow');
      return;
    }

    // average_speed 应为公里/小时
    const avgSpeed = laps.reduce((sum, lap) => sum + lap.average_speed, 0) / laps.length;

    if (avgSpeed < 1) {
      log(`  ✗ average_speed 单位异常: 平均值 ${avgSpeed.toFixed(4)} (期望: km/h, 典型约 5-15)`, 'red');
      this.addIssue('单位', 'Laps.average_speed 单位错误或计算错误');
    } else if (avgSpeed >= 5 && avgSpeed <= 20) {
      log(`  ✓ average_speed 单位: 公里/小时 (平均: ${avgSpeed.toFixed(2)} km/h)`, 'green');
    } else {
      log(`  ⚠ average_speed 平均值异常: ${avgSpeed.toFixed(2)} km/h`, 'yellow');
    }

    // distance 应为米（与 Activity 一致）
    const avgDistance = laps.reduce((sum, lap) => sum + lap.distance, 0) / laps.length;
    log(`  ✓ distance 单位: 米 (平均: ${avgDistance.toFixed(0)} m)`, 'green');
  }

  validateLapCalculations() {
    log('\n4. Activity_laps 表计算验证', 'cyan');

    // Sample activities with laps
    const activitiesWithLaps = this.db.prepare(`
      SELECT DISTINCT activity_id
      FROM activity_laps
      LIMIT 20
    `).all();

    if (activitiesWithLaps.length === 0) {
      log('  ⚠ 没有分段数据', 'yellow');
      return;
    }

    let speedCalcErrors = 0;
    let paceCalcErrors = 0;
    let cumulativeTimeErrors = 0;
    let distanceSumErrors = 0;

    activitiesWithLaps.forEach(({ activity_id }) => {
      const laps = this.db.prepare(`
        SELECT lap_index, distance, duration, average_speed, average_pace, cumulative_time
        FROM activity_laps
        WHERE activity_id = ?
        ORDER BY lap_index
      `).all(activity_id);

      const activity = this.db.prepare(`
        SELECT distance as total_distance FROM activities WHERE activity_id = ?
      `).get(activity_id);

      let expectedCumulativeTime = 0;

      laps.forEach(lap => {
        // average_speed 公里/小时 = (distance米 / duration秒) * 3.6
        if (lap.duration > 0 && lap.distance > 0) {
          const expectedSpeed = (lap.distance / lap.duration) * 3.6;
          if (lap.average_speed != null && Math.abs(expectedSpeed - lap.average_speed) > 0.01) {
            speedCalcErrors++;
          }

          // average_pace 秒/公里 = duration / (distance/1000)
          const expectedPace = (lap.duration * 1000) / lap.distance;
          if (lap.average_pace != null && Math.abs(expectedPace - lap.average_pace) > 0.01) {
            paceCalcErrors++;
          }
        }

        // Validate cumulative_time
        expectedCumulativeTime += lap.duration;
        if (Math.abs(expectedCumulativeTime - lap.cumulative_time) > 1) {
          cumulativeTimeErrors++;
        }
      });

      // Validate total distance: lap 距离是**米**，activity.distance 是**公里**（DB 契约）。
      // 旧写法直接比 lapDistanceSum(m) 与 total_distance(km)，对真实库 20/20 条活动
      // 全部误判「分段距离总和不一致」（6779m vs 6.779km）—— 每跑一次校验就报 20 条假警。
      const lapDistanceSumKm = laps.reduce((sum, lap) => sum + lap.distance, 0) / 1000;
      if (activity && Math.abs(lapDistanceSumKm - activity.total_distance) > 0.001) {
        distanceSumErrors++;
      }
    });

    if (speedCalcErrors === 0) {
      log(`  ✓ average_speed 计算: 正确`, 'green');
    } else {
      log(`  ✗ average_speed 计算错误: ${speedCalcErrors} 条分段`, 'red');
      this.addIssue('计算', `Laps.average_speed 计算错误 ${speedCalcErrors} 条`);
    }

    if (paceCalcErrors === 0) {
      log(`  ✓ average_pace 计算: 正确`, 'green');
    } else {
      log(`  ✗ average_pace 计算错误: ${paceCalcErrors} 条分段`, 'red');
      this.addIssue('计算', `Laps.average_pace 计算错误 ${paceCalcErrors} 条`);
    }

    if (cumulativeTimeErrors === 0) {
      log(`  ✓ cumulative_time 累加: 正确`, 'green');
    } else {
      log(`  ✗ cumulative_time 累加错误: ${cumulativeTimeErrors} 条分段`, 'red');
      this.addIssue('计算', `Laps.cumulative_time 累加错误 ${cumulativeTimeErrors} 条`);
    }

    if (distanceSumErrors === 0) {
      log(`  ✓ 分段距离总和: 与活动总距离一致`, 'green');
    } else {
      log(`  ⚠ 分段距离总和: ${distanceSumErrors} 个活动不一致`, 'yellow');
      this.addWarning('数据一致性', `${distanceSumErrors} 个活动的分段距离总和不一致`);
    }
  }

  validateNullValues() {
    log('5. NULL 值统计', 'cyan');

    const fields = [
      'average_cadence', 'max_cadence', 'average_stride_length',
      'average_vertical_oscillation', 'average_vertical_ratio',
      'average_ground_contact_time', 'average_gct_balance',
      'average_power', 'max_power', 'total_ascent', 'total_descent',
      'vdot_value', 'training_load'
    ];

    const totalCount = this.db.prepare('SELECT COUNT(*) as count FROM activities').get().count;

    fields.forEach(field => {
      const nullCount = this.db.prepare(`
        SELECT COUNT(*) as count FROM activities WHERE ${field} IS NULL
      `).get().count;

      const percentage = ((nullCount / totalCount) * 100).toFixed(1);
      const nonNullCount = totalCount - nullCount;

      if (nullCount === totalCount) {
        log(`  ⚠ ${field}: ${nonNullCount}/${totalCount} (${percentage}% NULL) - 全部缺失`, 'yellow');
        this.addWarning('数据完整性', `${field} 全部为 NULL`);
      } else if (percentage > 50) {
        log(`  ⚠ ${field}: ${nonNullCount}/${totalCount} (${percentage}% NULL)`, 'yellow');
      } else if (percentage > 0) {
        log(`  ✓ ${field}: ${nonNullCount}/${totalCount} (${percentage}% NULL)`, 'green');
      } else {
        log(`  ✓ ${field}: ${nonNullCount}/${totalCount} (完整)`, 'green');
      }
    });
  }

  validateDataRanges() {
    log('\n6. 数据范围验证', 'cyan');

    // 这些范围全部是**跑步口径**的合理区间（步频 150-220 spm、触地 150-350ms、
    // 心率 100-200bpm 等）。真实库含 107 条非跑步活动：篮球步频 16、力量训练
    // 平均心率 68、乒乓最大心率 98 —— 全部落在「合理范围」之外，但它们本来就是
    // 另一种运动，不是异常数据。旧实现不筛运动类型，每次校验都报 83 条假警
    // （cadence 13 + avgHR 53 + maxHR 17），真正需要看的 3 条跑步异常被埋掉。
    const ranges = {
      average_cadence: { min: 150, max: 220, unit: '步/分钟', runningOnly: true },
      average_vertical_oscillation: { min: 5, max: 15, unit: '厘米', runningOnly: true },
      average_ground_contact_time: { min: 150, max: 350, unit: '毫秒', runningOnly: true },
      average_gct_balance: { min: 45, max: 55, unit: '%', runningOnly: true },
      average_vertical_ratio: { min: 5, max: 15, unit: '%', runningOnly: true },
      average_heart_rate: { min: 100, max: 200, unit: 'bpm', runningOnly: true },
      max_heart_rate: { min: 120, max: 220, unit: 'bpm', runningOnly: true },
    };

    // 跑步类型集合与 app/lib/sport.ts 一致（缺 activity_type 视为跑步，兼容旧库）
    const RUNNING_ONLY = `(activity_type IS NULL OR activity_type = ''
      OR activity_type IN ('running', 'track_running', 'treadmill_running'))`;

    Object.entries(ranges).forEach(([field, range]) => {
      const scope = range.runningOnly ? ` AND ${RUNNING_ONLY}` : '';
      const stats = this.db.prepare(`
        SELECT
          MIN(${field}) as min_val,
          MAX(${field}) as max_val,
          AVG(${field}) as avg_val,
          COUNT(*) as count
        FROM activities
        WHERE ${field} IS NOT NULL${scope}
      `).get();

      if (stats.count === 0) {
        return;
      }

      const outOfRange = this.db.prepare(`
        SELECT COUNT(*) as count
        FROM activities
        WHERE ${field} IS NOT NULL
          AND (${field} < ? OR ${field} > ?)${scope}
      `).get(range.min, range.max).count;

      if (outOfRange === 0) {
        log(`  ✓ ${field}: ${stats.min_val.toFixed(1)}-${stats.max_val.toFixed(1)} ${range.unit} (在合理范围)`, 'green');
      } else {
        log(`  ⚠ ${field}: ${stats.min_val.toFixed(1)}-${stats.max_val.toFixed(1)} ${range.unit} (${outOfRange} 条超出范围 ${range.min}-${range.max})`, 'yellow');
        this.addWarning('数据范围', `${field} 有 ${outOfRange} 条记录超出合理范围`);
      }
    });
  }

  validateRelationships() {
    log('\n7. 关联性验证', 'cyan');

    // Check foreign key integrity
    const orphanedLaps = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM activity_laps
      WHERE activity_id NOT IN (SELECT activity_id FROM activities)
    `).get().count;

    if (orphanedLaps === 0) {
      log('  ✓ 外键完整性: 所有分段都关联到有效活动', 'green');
    } else {
      log(`  ✗ 外键完整性: ${orphanedLaps} 条分段记录孤立`, 'red');
      this.addIssue('数据完整性', `${orphanedLaps} 条分段记录没有对应的活动`);
    }

    // Check lap count reasonability
    const lapStats = this.db.prepare(`
      SELECT
        activity_id,
        COUNT(*) as lap_count,
        SUM(distance) as total_distance
      FROM activity_laps
      GROUP BY activity_id
      HAVING lap_count > 100 OR lap_count < 1
    `).all();

    if (lapStats.length === 0) {
      log('  ✓ 分段数量: 合理范围 (1-100)', 'green');
    } else {
      log(`  ⚠ ${lapStats.length} 个活动的分段数量异常`, 'yellow');
      this.addWarning('数据范围', `${lapStats.length} 个活动的分段数量异常`);
    }
  }

  /**
   * 心率区间口径验证（2026-10-27 新增）。
   *
   * `activities.time_in_hr_zone` 的唯一合法口径是**本地 5 区模型**：JSON 数组长度
   * 恒为 5，由 `activity_records` 的逐秒心率推导。设备原始数组（长度 6–8、边界方案
   * 随固件而变）只允许出现在 `device_time_in_hr_zone`。
   *
   * 为什么要专门校验：该列历史上直接存设备数组，导致 `/insight` 与 `/analysis`
   * 同一指标两个答案（Z1–Z2 轻松占比 4.7% vs 72.5%）。回填脚本首版还有一个静默
   * 数据丢失缺陷（顺序错误让 140 条设备数组被覆盖）。这两个缺陷都不会抛异常，
   * 只会在页面数字里显形 —— 必须让例行校验能自动抓出来。
   */
  validateHrZoneScope() {
    log('\n8. 心率区间口径验证', 'cyan');

    const rows = this.db.prepare(`
      SELECT activity_id, moving_time, duration, time_in_hr_zone
      FROM activities
      WHERE time_in_hr_zone IS NOT NULL
    `).all();

    if (rows.length === 0) {
      log('  ⚠ 无任何心率区间数据', 'yellow');
      return;
    }

    let badJson = 0;
    let badLength = 0;
    let badSum = 0;
    const sumOutliers = [];

    for (const row of rows) {
      let arr;
      try {
        arr = JSON.parse(row.time_in_hr_zone);
      } catch {
        badJson++;
        continue;
      }
      if (!Array.isArray(arr) || arr.length !== 5) {
        badLength++;
        continue;
      }
      // 推导秒数应贴近 moving_time（暂停空档按 5s 截断）。实测 348 条中仅
      // 1 条偏离 >10%（短活动 122s 期望 / 139s 推导），故只告警不判错。
      const base = row.moving_time || row.duration || 0;
      if (base > 60) {
        const sum = arr.reduce((a, b) => a + (Number(b) || 0), 0);
        if (Math.abs(sum - base) / base > 0.1) {
          badSum++;
          if (sumOutliers.length < 5) {
            sumOutliers.push(`${row.activity_id}(${sum}s vs ${base}s)`);
          }
        }
      }
    }

    if (badJson === 0 && badLength === 0) {
      log(`  ✓ 区间数组口径: 长度恒为 5 (本地 5 区模型, ${rows.length} 条)`, 'green');
    } else {
      log(`  ✗ 区间数组口径异常: 坏 JSON ${badJson} 条 / 长度非 5 ${badLength} 条`, 'red');
      this.addIssue(
        '区间口径',
        `time_in_hr_zone 必须是本地 5 区模型（长度 5）: 坏 JSON ${badJson} / 长度异常 ${badLength}`,
      );
    }

    if (badSum === 0) {
      log('  ✓ 区间秒数与 moving_time 一致 (偏差 ≤10%)', 'green');
    } else {
      log(`  ⚠ 区间秒数与 moving_time 偏离 >10%: ${badSum} 条 (${sumOutliers.join(', ')})`, 'yellow');
      this.addWarning('区间口径', `${badSum} 条活动的区间秒数与 moving_time 偏离 >10%`);
    }
  }

  /**
   * schema 漂移验证（2026-10-27 新增）。
   *
   * ## 为什么需要
   *
   * 生产库的列集合可能**落后于代码**。`_initDatabase` 只在 `DatabaseManager`
   * 打开库时补列，但有些路径直接用 `better-sqlite3` 打开同一个库（回填脚本、
   * 只读查询），那些路径永远不触发迁移。真实事故：本次新增
   * `activities.device_time_in_speed_zone` / `device_time_in_cadence_zone` 后，
   * 生产库仍是 78 列、缺这两列，只多出两个旧的 `time_in_speed_zone` /
   * `time_in_cadence_zone` —— 而**读写两侧都不报错**：
   *   - 写：`upsertActivity` 按对象键拼 SQL，没写到的列只是静默缺失；
   *   - 读：`SELECT *` 少两列，`Activity` 里对应字段永远是 `undefined`。
   * 于是「设备原始速度区间」这条数据在库里根本没有落点，而没人会发现。
   *
   * ## 判据
   *
   * 真值来源是 `DatabaseManager.declaredColumns()`（内存库走同一条建表+迁移
   * 路径得到），不是把列名再抄一遍 —— 抄一遍就又变成两份定义。
   *
   * - **缺列** = 代码声明了、库里没有 → **判错**（写入会静默丢数据）
   * - **多列** = 库里有、代码不声明 → 只**告警**（历史遗留列本身无害，
   *   但说明迁移没清理；若它是旧口径的统一列则可能是口径陷阱）
   */
  validateSchemaDrift() {
    log('\n9. schema 漂移验证', 'cyan');

    for (const table of ['activities', 'activity_laps']) {
      const declared = DatabaseManager.declaredColumns(table);
      const actual = this.db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name);

      const missing = declared.filter((c) => !actual.includes(c));
      const extra = actual.filter((c) => !declared.includes(c));

      if (missing.length === 0 && extra.length === 0) {
        log(`  ✓ ${table}: ${actual.length} 列与代码声明一致`, 'green');
        continue;
      }
      if (missing.length > 0) {
        // 缺列是硬错误: 写入这些列会抛「no column named」或静默跳过。
        log(`  ✗ ${table} 缺 ${missing.length} 列（代码声明但库里没有）:`, 'red');
        log(`     ${missing.join(', ')}`, 'red');
        this.addIssue('schema 漂移', `${table} 缺列: ${missing.join(', ')}（用 DatabaseManager 打开库即可自动补列）`);
      }
      if (extra.length > 0) {
        log(`  ⚠ ${table} 多 ${extra.length} 列（库里有但代码不声明）:`, 'yellow');
        log(`     ${extra.join(', ')}`, 'yellow');
        this.addWarning('schema 漂移', `${table} 多余列: ${extra.join(', ')}`);
      }
    }
  }

  printSummary() {
    log('\n╔═══════════════════════════════════════════════════════╗', 'blue');
    log('║        验证总结                                        ║', 'blue');
    log('╚═══════════════════════════════════════════════════════╝\n', 'blue');

    if (this.issues.length === 0 && this.warnings.length === 0) {
      log('✓ 所有验证通过！数据格式和内容与 FIT 数据一致。\n', 'green');
      return;
    }

    if (this.issues.length > 0) {
      log(`发现 ${this.issues.length} 个问题:\n`, 'red');
      this.issues.forEach((issue, idx) => {
        log(`  ${idx + 1}. [${issue.category}] ${issue.message}`, 'red');
      });
      log('');
    }

    if (this.warnings.length > 0) {
      log(`发现 ${this.warnings.length} 个警告:\n`, 'yellow');
      this.warnings.forEach((warning, idx) => {
        log(`  ${idx + 1}. [${warning.category}] ${warning.message}`, 'yellow');
      });
      log('');
    }

    // Recommendations
    log('建议:', 'cyan');
    if (this.issues.some(i => i.message.includes('average_speed'))) {
      log('  - 检查 fit-parser.js 中 Laps 的 average_speed 计算逻辑', 'cyan');
    }
    if (this.warnings.some(w => w.message.includes('average_stride_length'))) {
      log('  - 确认 FIT 文件是否包含步幅数据，检查字段映射是否正确', 'cyan');
    }
    if (this.issues.some(i => i.message.includes('单位'))) {
      log('  - 更新数据库表结构注释，确保单位说明准确', 'cyan');
    }
    log('');
  }

  close() {
    this.db.close();
  }
}

// CLI
async function main() {
  try {
    const validator = new DataValidator();
    await validator.validate();
    validator.close();
  } catch (error) {
    log(`\n✗ 验证失败: ${error.message}`, 'red');
    console.error(error.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = DataValidator;
