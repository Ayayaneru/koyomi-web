package com.koyomi.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 自定义插件要在 super.onCreate 之前注册
        registerPlugin(SaveFilePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
