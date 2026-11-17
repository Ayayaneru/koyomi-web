package com.koyomi.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.List;

/**
 * 桌面小工具（2026-11-15）：高 1 格、宽 2 格。
 *
 * 这里不做业务判断：快照是 Web 端算好的（最近 N 天里的 M 条，逾期任务排最前），
 * 原生只按系统时钟再筛一遍（已经结束的日程不显示）并渲染，只画两行。
 * 系统按 updatePeriodMillis 唤醒，不常驻、不会被杀。
 */
public class KoyomiWidgetProvider extends AppWidgetProvider {

    private static final int MAX_ROWS = 2;
    private static final int[] ROW_TITLE = { R.id.widget_title_1, R.id.widget_title_2 };
    private static final int[] ROW_TIME = { R.id.widget_time_1, R.id.widget_time_2 };
    private static final int[] ROW_BOX = { R.id.widget_row_1, R.id.widget_row_2 };

    /** App 里数据一变就让桌面上的小工具重画 */
    static void refreshAll(Context context) {
        Context app = context.getApplicationContext();
        AppWidgetManager manager = AppWidgetManager.getInstance(app);
        int[] ids = manager.getAppWidgetIds(new ComponentName(app, KoyomiWidgetProvider.class));
        if (ids == null || ids.length == 0) return;

        Intent intent = new Intent(app, KoyomiWidgetProvider.class);
        intent.setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE);
        intent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids);
        app.sendBroadcast(intent);
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) {
            manager.updateAppWidget(id, build(context, id));
        }
    }

    private static RemoteViews build(Context context, int widgetId) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.koyomi_widget);
        long now = System.currentTimeMillis();

        List<JSONObject> rows = new ArrayList<>();
        JSONArray entries = null;
        try {
            String raw = KoyomiWidgetStore.snapshot(context);
            if (!raw.isEmpty()) entries = new JSONObject(raw).optJSONArray("entries");
        } catch (Exception ignored) {
            // 快照坏了就当没有，不要让桌面上出现一个红叉
        }
        if (entries != null) {
            for (int i = 0; i < entries.length() && rows.size() < MAX_ROWS; i++) {
                JSONObject entry = entries.optJSONObject(i);
                if (entry == null) continue;
                long at = entry.optLong("at", 0);
                long endAt = entry.optLong("endAt", at);
                boolean task = "task".equals(entry.optString("kind"));
                if (task || endAt >= now) rows.add(entry);
            }
        }

        views.setViewVisibility(R.id.widget_empty, rows.isEmpty() ? View.VISIBLE : View.GONE);

        for (int i = 0; i < MAX_ROWS; i++) {
            if (i < rows.size()) {
                JSONObject entry = rows.get(i);
                long at = entry.optLong("at", now);
                views.setViewVisibility(ROW_BOX[i], View.VISIBLE);
                views.setTextViewText(ROW_TITLE[i], entry.optString("title", ""));
                views.setTextViewText(ROW_TIME[i], labelFor(at, now, "task".equals(entry.optString("kind"))));
                views.setViewVisibility(ROW_TIME[i], View.VISIBLE);

                String path = entry.optString("path", "");
                if (!path.isEmpty()) {
                    views.setOnClickPendingIntent(ROW_BOX[i], openIntent(context, widgetId, i, path));
                }
            } else {
                views.setViewVisibility(ROW_BOX[i], View.GONE);
            }
        }
        return views;
    }

    private static PendingIntent openIntent(Context context, int widgetId, int row, String path) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setData(Uri.parse("koyomi://open?path=" + Uri.encode(path)));
        intent.putExtra("koyomi_open_path", path);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int requestCode = widgetId * 10 + row;
        return PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    /** 右侧标签：今天 / 明天 / 周X + HH:mm；逾期任务固定显示「逾期」 */
    private static String labelFor(long at, long now, boolean task) {
        if (task && at < now) return "逾期";

        Calendar target = Calendar.getInstance();
        target.setTimeInMillis(at);
        Calendar today = Calendar.getInstance();
        today.setTimeInMillis(now);

        int diffDays = dayDiff(today, target);
        if (diffDays == 0) return "今天 " + hhmm(target);
        if (diffDays == 1) return "明天 " + hhmm(target);
        if (diffDays > 1 && diffDays < 7) return weekName(target) + " " + hhmm(target);
        return (target.get(Calendar.MONTH) + 1) + "月" + target.get(Calendar.DAY_OF_MONTH) + "日";
    }

    private static String hhmm(Calendar time) {
        int hour = time.get(Calendar.HOUR_OF_DAY);
        int minute = time.get(Calendar.MINUTE);
        return (hour < 10 ? "0" + hour : String.valueOf(hour)) + ":" + (minute < 10 ? "0" + minute : String.valueOf(minute));
    }

    /** 只比较「哪一天」，不看具体时刻 */
    private static int dayDiff(Calendar from, Calendar to) {
        Calendar a = (Calendar) from.clone();
        Calendar b = (Calendar) to.clone();
        a.set(Calendar.HOUR_OF_DAY, 0);
        a.set(Calendar.MINUTE, 0);
        a.set(Calendar.SECOND, 0);
        a.set(Calendar.MILLISECOND, 0);
        b.set(Calendar.HOUR_OF_DAY, 0);
        b.set(Calendar.MINUTE, 0);
        b.set(Calendar.SECOND, 0);
        b.set(Calendar.MILLISECOND, 0);
        return (int) ((b.getTimeInMillis() - a.getTimeInMillis()) / 86_400_000L);
    }

    private static String weekName(Calendar time) {
        switch (time.get(Calendar.DAY_OF_WEEK)) {
            case Calendar.MONDAY: return "周一";
            case Calendar.TUESDAY: return "周二";
            case Calendar.WEDNESDAY: return "周三";
            case Calendar.THURSDAY: return "周四";
            case Calendar.FRIDAY: return "周五";
            case Calendar.SATURDAY: return "周六";
            default: return "周日";
        }
    }
}
