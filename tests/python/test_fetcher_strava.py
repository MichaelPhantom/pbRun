"""
Strava Fetcher 功能测试
测试数据获取、转换、GPX生成等核心功能
"""

import sys
import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock, patch, MagicMock

# Add scripts/strava to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'scripts', 'strava'))

# Mock external dependencies before import
sys.modules['stravalib'] = MagicMock()
sys.modules['stravalib.client'] = MagicMock()
sys.modules['gpxpy'] = MagicMock()
sys.modules['gpxpy.gpx'] = MagicMock()

from fetcher import (
    parse_quantity,
    format_duration,
    format_pace,
    pace_to_seconds,
    infer_sub_sport_type,
    StravaFetcher,
)


class TestParseQuantity(unittest.TestCase):
    """测试数值解析功能"""

    def test_parse_none(self):
        """测试空值处理"""
        self.assertEqual(parse_quantity(None), 0.0)

    def test_parse_number(self):
        """测试普通数值"""
        self.assertEqual(parse_quantity(100), 100.0)
        self.assertEqual(parse_quantity(3.5), 3.5)

    def test_parse_quantity_object(self):
        """测试 pint Quantity 对象"""
        mock_qty = Mock()
        mock_qty.magnitude = 5000
        self.assertEqual(parse_quantity(mock_qty), 5000.0)


class TestFormatDuration(unittest.TestCase):
    """测试时长格式化功能"""

    def test_format_none(self):
        """测试空值"""
        self.assertIsNone(format_duration(None))

    def test_format_timedelta(self):
        """测试 timedelta 对象"""
        td = timedelta(seconds=3661)
        self.assertEqual(format_duration(td), "1:01:01")

    def test_format_seconds(self):
        """测试秒数"""
        self.assertEqual(format_duration(61), "1:01")
        self.assertEqual(format_duration(3661), "1:01:01")
        self.assertEqual(format_duration(1500), "25:00")


class TestFormatPace(unittest.TestCase):
    """测试配速格式化功能"""

    def test_format_none(self):
        """测试空值和零值"""
        self.assertIsNone(format_pace(None))
        self.assertIsNone(format_pace(0))

    def test_format_valid(self):
        """测试有效配速"""
        # 4.0 m/s = 4:10/km
        self.assertEqual(format_pace(4.0), "4:10")
        # 3.33 m/s ≈ 5:00/km
        self.assertEqual(format_pace(3.33), "5:00")


class TestPaceToSeconds(unittest.TestCase):
    """测试配速转秒数功能"""

    def test_pace_none(self):
        """测试空值"""
        self.assertIsNone(pace_to_seconds(None))
        self.assertIsNone(pace_to_seconds(0))

    def test_pace_valid(self):
        """测试有效配速"""
        # 4.0 m/s = 250 sec/km = 4:10
        self.assertEqual(pace_to_seconds(4.0), 250)
        # 3.33 m/s ≈ 300 sec/km = 5:00
        self.assertEqual(pace_to_seconds(3.33), 300)


class TestInferSubSportType(unittest.TestCase):
    """测试子类型推断功能"""

    def test_treadmill_no_gps(self):
        """测试无 GPS 时识别为跑步机"""
        activity = Mock()
        activity.map = None
        self.assertEqual(infer_sub_sport_type(activity), '跑步机')

    def test_treadmill_empty_polyline(self):
        """测试空轨迹时识别为跑步机"""
        activity = Mock()
        activity.map = Mock()
        activity.map.summary_polyline = None
        self.assertEqual(infer_sub_sport_type(activity), '跑步机')

    def test_treadmill_from_name(self):
        """测试从名称识别跑步机"""
        activity = Mock()
        activity.map = Mock()
        activity.map.summary_polyline = "some_polyline"
        activity.name = "Morning Treadmill Run"
        self.assertEqual(infer_sub_sport_type(activity), '跑步机')

    def test_trail_from_name(self):
        """测试从名称识别越野"""
        activity = Mock()
        activity.map = Mock()
        activity.map.summary_polyline = "some_polyline"
        activity.name = "Trail Running in Mountains"
        self.assertEqual(infer_sub_sport_type(activity), '越野')

    def test_road_default(self):
        """测试默认路跑"""
        activity = Mock()
        activity.map = Mock()
        activity.map.summary_polyline = "some_polyline"
        activity.name = "Morning Run"
        self.assertEqual(infer_sub_sport_type(activity), '路跑')


class TestStravaFetcher(unittest.TestCase):
    """测试 StravaFetcher 类"""

    def setUp(self):
        """测试前准备"""
        with patch('fetcher.Client'):
            self.fetcher = StravaFetcher('client_id', 'client_secret', 'refresh_token')

    def test_init(self):
        """测试初始化"""
        self.assertEqual(self.fetcher.client_id, 'client_id')
        self.assertEqual(self.fetcher.client_secret, 'client_secret')
        self.assertEqual(self.fetcher.refresh_token, 'refresh_token')


class TestDataTransformation(unittest.TestCase):
    """transform_activity_data: Strava API 字段 → pbRun schema（DB 契约单位）"""

    def setUp(self):
        with patch('fetcher.Client'):
            self.fetcher = StravaFetcher('client_id', 'client_secret', 'refresh_token')

    def _activity(self, **over):
        """Strava API 原始活动（米 / m/s / rpm）。"""
        base = Mock()
        base.id = 123456789
        base.name = 'Morning Run'
        base.distance = 10000.0          # 米
        base.moving_time = 3600          # 秒
        base.elapsed_time = 3700
        base.average_speed = 2.778       # m/s → 10 km/h
        base.max_speed = 4.5             # m/s → 16.2 km/h
        base.average_heartrate = 150.0
        base.max_heartrate = 170.0
        base.average_cadence = 85.0      # rpm → 170 spm
        base.max_cadence = 90.0
        base.calories = 500
        base.total_elevation_gain = 50.0
        base.average_watts = 250
        base.max_watts = 400
        base.start_date = datetime(2026, 4, 9, 8, 30, tzinfo=timezone.utc)
        base.start_date_local = datetime(2026, 4, 9, 16, 30, tzinfo=timezone(timedelta(hours=8)))
        base.map = Mock()
        base.map.summary_polyline = 'encoded'
        for k, v in over.items():
            setattr(base, k, v)
        return base

    def test_transform_basic_fields(self):
        """距离米→公里, 时长取整, 心率/卡路里/爬升直传"""
        data = self.fetcher.transform_activity_data(self._activity(), None, [])
        self.assertEqual(data['distance'], 10.0)          # 10000m → 10km
        self.assertEqual(data['duration'], 3600)
        self.assertEqual(data['elapsed_time'], 3700)
        self.assertEqual(data['average_heart_rate'], 150)
        self.assertEqual(data['max_heart_rate'], 170)
        self.assertEqual(data['calories'], 500)
        self.assertEqual(data['total_ascent'], 50.0)
        self.assertEqual(data['source'], 'strava')

    def test_transform_distance(self):
        """distance 落库单位为公里（DB 契约: activities.distance 是 km）"""
        data = self.fetcher.transform_activity_data(self._activity(distance=5000.0), None, [])
        self.assertEqual(data['distance'], 5.0)

    def test_transform_pace(self):
        """配速 2.778 m/s → 360 s/km（秒/公里）"""
        data = self.fetcher.transform_activity_data(self._activity(), None, [])
        self.assertEqual(data['average_pace'], 360)

    def test_transform_speeds_both_kmh(self):
        """
        average_speed 与 max_speed 必须同为 km/h（DB 契约）。

        Strava API 给的是 m/s，旧实现只给 average_speed 乘 3.6，max_speed 原样
        落库 m/s —— 同一个 max_speed 列混着 Garmin 的 km/h 与 Strava 的 m/s，
        读取方无论怎么换算都必错一半（AI prompt 曾按 m/s 再乘 3.6，
        真实 Garmin 行 20.76km/h 被报成 74.7km/h）。
        """
        data = self.fetcher.transform_activity_data(self._activity(), None, [])
        self.assertEqual(data['average_speed'], 10.0)     # 2.778 m/s → 10 km/h
        self.assertEqual(data['max_speed'], 16.2)         # 4.5 m/s → 16.2 km/h

    def test_transform_cadence_rpm_to_spm(self):
        """Strava 步频是单侧 rpm, ×2 才是步/分"""
        data = self.fetcher.transform_activity_data(self._activity(), None, [])
        self.assertEqual(data['average_cadence'], 170)
        self.assertEqual(data['max_cadence'], 180)

    def test_transform_missing_max_speed_is_none(self):
        """无 max_speed 时落 None, 不是 0.0（0 会被当成「速度为零」的坏数据）"""
        data = self.fetcher.transform_activity_data(self._activity(max_speed=None), None, [])
        self.assertIsNone(data['max_speed'])


if __name__ == '__main__':
    unittest.main()
