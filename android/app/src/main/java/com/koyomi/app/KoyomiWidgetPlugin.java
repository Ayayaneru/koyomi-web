package com.koyomi.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 小工具和 Web 之间的桥（2026-11-15）。
 *
 * save：Web 算好快照传进来 → 存 SharedPreferences → 立刻重画桌面上的小工具。
 * consumeOpen：取走用户上次点的路径（取完即清），Web 用它决定跳哪个页面。
 */
@CapacitorPlugin(name = "KoyomiWidget")
public class KoyomiWidgetPlugin extends Plugin {

    @PluginMethod
    public void save(PluginCall call) {
        String snapshot = call.getString("snapshot", "");
        if (snapshot == null || snapshot.isEmpty()) {
            call.reject("快照是空的");
            return;
        }
        KoyomiWidgetStore.saveSnapshot(getContext(), snapshot);
        KoyomiWidgetProvider.refreshAll(getContext());
        call.resolve();
    }

    @PluginMethod
    public void consumeOpen(PluginCall call) {
        JSObject ret = new JSObject();
        String path = KoyomiWidgetStore.takePendingOpen(getContext());
        if (!path.isEmpty()) ret.put("path", path);
        call.resolve(ret);
    }
}
