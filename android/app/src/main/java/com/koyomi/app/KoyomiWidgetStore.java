package com.koyomi.app;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * 小工具和 App 之间的一个抽屉（2026-11-15）。
 *
 * 数据在 WebView 的 IndexedDB 里，原生存不到，所以 App 在前台时把算好的快照写进来；
 * 另一头存「用户点了小工具的哪一条」，App 启动 / 回到前台时取走再跳页面。
 */
final class KoyomiWidgetStore {

    private static final String PREFS = "koyomi_widget";
    private static final String KEY_SNAPSHOT = "snapshot";
    private static final String KEY_OPEN = "pending_open";

    private KoyomiWidgetStore() {}

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static void saveSnapshot(Context context, String json) {
        prefs(context).edit().putString(KEY_SNAPSHOT, json).apply();
    }

    static String snapshot(Context context) {
        String json = prefs(context).getString(KEY_SNAPSHOT, "");
        return json == null ? "" : json;
    }

    static void setPendingOpen(Context context, String path) {
        prefs(context).edit().putString(KEY_OPEN, path).apply();
    }

    /** 取一次就清掉：同一条点击不会让 App 连跳两次 */
    static String takePendingOpen(Context context) {
        String path = prefs(context).getString(KEY_OPEN, "");
        if (path != null && !path.isEmpty()) {
            prefs(context).edit().remove(KEY_OPEN).apply();
            return path;
        }
        return "";
    }
}
