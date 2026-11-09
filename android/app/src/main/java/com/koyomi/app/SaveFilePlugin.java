package com.koyomi.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * 「保存到手机」用的最小插件（2026-11-02）。
 *
 * 系统分享面板里不一定有「保存到文件」（取决于手机装了哪些 App），而 WebView 又不会处理
 * `<a download>`。所以这里直接用 Storage Access Framework：ACTION_CREATE_DOCUMENT，
 * 让用户自己选目录（下载 / Documents / 网盘都行），全程不需要任何存储权限。
 */
@CapacitorPlugin(name = "SaveFile")
public class SaveFilePlugin extends Plugin {

    @PluginMethod
    public void save(PluginCall call) {
        String fileName = call.getString("fileName", "koyomi.json");
        String mime = call.getString("mime", "application/json");

        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime);
        intent.putExtra(Intent.EXTRA_TITLE, fileName);
        startActivityForResult(call, intent, "saveResult");
    }

    @ActivityCallback
    private void saveResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("取消保存");
            return;
        }

        Uri uri = result.getData().getData();
        String data = call.getString("data", "");
        try (OutputStream out = getContext().getContentResolver().openOutputStream(uri)) {
            if (out == null) {
                call.reject("打不开目标文件");
                return;
            }
            out.write(data.getBytes(StandardCharsets.UTF_8));
            out.flush();
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage() == null ? "写入失败" : e.getMessage());
        }
    }
}
