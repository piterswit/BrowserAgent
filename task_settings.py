DEFAULT_TASK_SETTINGS = {"activity_minutes": 5, "cancel_request_limit": 100}
TASK_SETTING_RANGES = {"activity_minutes": (1, 1440), "cancel_request_limit": (1, 1000)}


def normalize_task_settings(value):
    source = value if isinstance(value, dict) else {}
    return {
        key: source[key] if type(source.get(key)) is int and lower <= source[key] <= upper else default
        for key, default in DEFAULT_TASK_SETTINGS.items()
        for lower, upper in [TASK_SETTING_RANGES[key]]
    }


def validate_task_settings(value):
    result = {}
    for key, label in (("activity_minutes", "活跃时长"), ("cancel_request_limit", "取消请求数量")):
        raw = value.get(key)
        text = str(raw).strip()
        lower, upper = TASK_SETTING_RANGES[key]
        if not text.isdecimal() or not lower <= int(text) <= upper:
            raise ValueError(f"{label}请输入 {lower}–{upper} 之间的整数。")
        result[key] = int(text)
    return result
