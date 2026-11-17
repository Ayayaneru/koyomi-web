package com.koyomi.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

import org.json.JSONObject;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 自定义插件要在 super.onCreate 之前注册
        registerPlugin(SaveFilePlugin.class);
        registerPlugin(KoyomiWidgetPlugin.class);
        super.onCreate(savedInstanceState);
    }

    /**
     * 桌面小工具被点时走到这里（2026-11-15）。
     *
     * 冷启动时 BridgeActivity.load() 建好 bridge 后会回放一次 onNewIntent，
     * 所以路径先写进 pending_open；同时若 bridge 已就绪就顺手通知一下 Web，
     * 两边都读到也不要紧 —— consumeOpen 取完就清，不会重复跳。
     */
    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent == null) return;

        String path = intent.getStringExtra("koyomi_open_path");
        if (path == null || path.isEmpty()) {
            Uri data = intent.getData();
            if (data != null) path = data.getQueryParameter("path");
        }
        if (path == null || path.isEmpty()) return;

        setIntent(intent);
        KoyomiWidgetStore.setPendingOpen(this, path);

        if (getBridge() != null) {
            try {
                getBridge().triggerWindowJSEvent("koyomiOpen", JSONObject.quote(path));
            } catch (Exception ignored) {
                // Web 这边还没装好监听也没事：启动时会再 consumeOpen 一次
            }
        }
    }
}
