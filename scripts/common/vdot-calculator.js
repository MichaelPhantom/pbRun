/**
 * VDOT calculator based on heart rate zones
 */

class VDOTCalculator {
  constructor(maxHr, restingHr) {
    this.maxHr = maxHr;
    this.restingHr = restingHr;
    this.hrReserve = maxHr - restingHr;
  }

  /**
   * Get heart rate zone (1-5) based on percentage of max HR
   */
  getHrZone(avgHr) {
    if (avgHr <= 0) return 0;

    const hrPercent = (avgHr / this.maxHr) * 100;

    if (hrPercent < 70) return 1;      // Zone 1: <70% (轻松跑)
    if (hrPercent < 80) return 2;      // Zone 2: 70-80% (有氧基础)
    if (hrPercent < 87) return 3;      // Zone 3: 80-87% (节奏跑)
    if (hrPercent < 93) return 4;      // Zone 4: 87-93% (乳酸阈)
    return 5;                          // Zone 5: >93% (最大摄氧量)
  }

  /**
   * Calculate VDOT using Daniels Running Formula
   *
   * Based on Jack Daniels' "Daniels' Running Formula"
   * @param {number} distanceMeters - Distance in meters
   * @param {number} durationSeconds - Duration in seconds
   * @param {number} avgHr - Average heart rate (optional)
   * @returns {number|null} VDOT value
   */
  calculateVdotFromPace(distanceMeters, durationSeconds, avgHr = null) {
    if (durationSeconds <= 0 || distanceMeters <= 0) {
      return null;
    }

    // Convert to minutes
    const durationMinutes = durationSeconds / 60;

    // Velocity in m/min (required by Daniels formula)
    const velocityMPerMin = distanceMeters / durationMinutes;

    if (velocityMPerMin <= 0) return null;

    // Calculate VO2 using Daniels formula (velocity in m/min)
    // VO2 = -4.60 + 0.182258 * v + 0.000104 * v²
    const vo2 = -4.60 + 0.182258 * velocityMPerMin + 0.000104 * (velocityMPerMin ** 2);

    // Calculate percent of VO2max based on duration (standard Daniels formula)
    // %VO2max = 0.8 + 0.1894393 * e^(-0.012778*t) + 0.2989558 * e^(-0.1932605*t)
    // t 拟合区间约 3.5–240 min；超出则 clamp 至 [0.8, 1.0]，不再对短/超长活动 return null
    const t = durationMinutes;
    let percentVo2max = 0.8
                        + 0.1894393 * Math.exp(-0.012778 * t)
                        + 0.2989558 * Math.exp(-0.1932605 * t);
    percentVo2max = Math.min(1.0, Math.max(0.8, percentVo2max));

    // Calculate VDOT — 纯 Daniels，不再做心率乘子修正（见审核报告：原 0.97/0.99 无依据且方向相反）
    const vdot = vo2 / percentVo2max;

    // Sanity check: VDOT typically ranges from 30-85 for most runners
    if (vdot < 20 || vdot > 100) {
      return null;
    }

    return Math.round(vdot * 10) / 10;
  }

  /**
   * 判断是否为“代表性强度”时段：仅 Z3+（≥80% maxHR）的全力/阈值段才计入 VDOT，
   * 日常轻松/恢复跑（Z1/Z2）直接跳过，避免把训练平均强度当成能力值
   */
  isRepresentativeEffort(avgHr) {
    if (avgHr == null || avgHr <= 0) return false;
    return this.getHrZone(avgHr) >= 3;
  }

  /**
   * Calculate training load based on duration and heart rate
   */
  calculateTrainingLoad(durationSeconds, avgHr = null) {
    if (durationSeconds <= 0) return 0;

    const durationHours = durationSeconds / 3600;

    // Base load from duration
    let baseLoad = durationHours * 100;

    // Adjust by HR zone if available
    if (avgHr && avgHr > 0) {
      const hrZone = this.getHrZone(avgHr);

      // Zone factors for training load
      const zoneFactors = {
        1: 0.6,   // Easy recovery
        2: 0.8,   // Aerobic base
        3: 1.0,   // Tempo
        4: 1.3,   // Threshold
        5: 1.5    // VO2max
      };

      const factor = zoneFactors[hrZone] || 1.0;
      baseLoad *= factor;
    }

    return Math.round(baseLoad);
  }

  /**
   * Analyze heart rate distribution across zones
   */
  analyzeHrDistribution(hrRecords) {
    if (!hrRecords || hrRecords.length === 0) {
      return {};
    }

    const zoneCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

    for (const hr of hrRecords) {
      if (hr > 0) {
        const zone = this.getHrZone(hr);
        if (zone in zoneCounts) {
          zoneCounts[zone]++;
        }
      }
    }

    const total = Object.values(zoneCounts).reduce((a, b) => a + b, 0);
    if (total === 0) return {};

    const distribution = {};
    for (const [zone, count] of Object.entries(zoneCounts)) {
      distribution[`zone_${zone}`] = (count / total) * 100;
    }

    return distribution;
  }
}

module.exports = VDOTCalculator;
