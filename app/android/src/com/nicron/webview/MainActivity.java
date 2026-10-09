package com.nicron.webview;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.animation.AlphaAnimation;
import android.webkit.MimeTypeMap;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Chaty's Android shell: Nitron's WebView activity (same class name, so
 * Nitron's manifest still points here) plus what a messenger needs on top:
 * call audio routing (window.ChatyAudio), the file picker for attachments,
 * pictures from the keyboard (ChatyWebView), and opening links and
 * downloads outside the app.
 */
public class MainActivity extends Activity {
    private static final String ASSET_HOST = "appassets.androidplatform.net";
    private static final String ASSET_PREFIX = "www/";
    private static final int FILE_REQUEST = 201;
    private String backButtonMode = "history";
    private boolean clearCacheOnStart = false;
    private FrameLayout rootLayout;
    private View splashView;
    private ChatyWebView webView;
    private CallAudio callAudio;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle bundle) {
        super.onCreate(bundle);
        requestWindowFeature(1);
        readMetaData();
        this.rootLayout = new FrameLayout(this);
        this.webView = new ChatyWebView(this);
        configureWebView();
        this.rootLayout.addView(this.webView, new FrameLayout.LayoutParams(-1, -1));
        setupSplashScreen();
        if (this.clearCacheOnStart) {
            this.webView.clearCache(true);
        }
        this.webView.loadUrl("https://appassets.androidplatform.net/index.html");
        setContentView(this.rootLayout);
    }

    private void configureWebView() {
        WebSettings settings = this.webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setCacheMode(-1);
        settings.setMixedContentMode(2);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(this.webView, true);
        this.webView.setWebViewClient(new NitronWebViewClient());
        this.webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest permissionRequest) {
                MainActivity.this.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        permissionRequest.grant(permissionRequest.getResources());
                    }
                });
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(String str, GeolocationPermissions.Callback callback) {
                callback.invoke(str, true, false);
            }

            // <input type="file">: attach photos, videos and files from the phone.
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent intent = pickerIntent(params.getAcceptTypes());
                if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }
                try {
                    startActivityForResult(intent, FILE_REQUEST);
                    return true;
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
            }
        });
        // Files the server sends as downloads open in the browser.
        this.webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String disposition, String mimetype, long length) {
                openOutside(Uri.parse(url));
            }
        });
        this.webView.addJavascriptInterface(new NitronJSInterface(), "Nitron");
        this.callAudio = new CallAudio(this, this.webView);
        this.webView.addJavascriptInterface(this.callAudio, "ChatyAudio");
    }

    // The WebView's own picker only honours the first type in accept="image/*,video/*".
    private static Intent pickerIntent(String[] accept) {
        List<String> types = new ArrayList<>();
        boolean any = accept == null || accept.length == 0;
        if (accept != null) {
            for (String a : accept) {
                for (String t : a.split(",")) {
                    t = t.trim().toLowerCase();
                    if (t.isEmpty()) continue;
                    if (t.startsWith(".")) t = MimeTypeMap.getSingleton().getMimeTypeFromExtension(t.substring(1));
                    if (t == null || t.equals("*/*")) any = true;
                    else if (!types.contains(t)) types.add(t);
                }
            }
        }
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        if (any || types.isEmpty()) {
            intent.setType("*/*");
        } else if (types.size() == 1) {
            intent.setType(types.get(0));
        } else {
            intent.setType("*/*");
            intent.putExtra(Intent.EXTRA_MIME_TYPES, types.toArray(new String[0]));
        }
        return intent;
    }

    private void openOutside(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException ignored) {
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != FILE_REQUEST) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        if (fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                result = new Uri[clip.getItemCount()];
                for (int i = 0; i < clip.getItemCount(); i++) result[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[] {data.getData()};
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == CallAudio.BLUETOOTH_REQUEST && callAudio != null) callAudio.onPermissionResult();
    }

    private class NitronWebViewClient extends WebViewClient {
        private NitronWebViewClient() {
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView webView, WebResourceRequest webResourceRequest) {
            Uri url = webResourceRequest.getUrl();
            if (MainActivity.ASSET_HOST.equals(url.getHost())) {
                String path = url.getPath();
                if (path != null && path.startsWith(ChatyWebView.KEYBOARD_PATH)) {
                    return MainActivity.this.webView.take(path);
                }
                if (path == null || path.isEmpty() || "/".equals(path)) {
                    path = "/index.html";
                }
                if (path.startsWith("/")) {
                    path = path.substring(1);
                }
                try {
                    InputStream inputStreamOpen = MainActivity.this.getAssets().open(MainActivity.ASSET_PREFIX + path);
                    String strResolveMimeType = MainActivity.resolveMimeType(path);
                    return new WebResourceResponse(strResolveMimeType, MainActivity.isTextMimeType(strResolveMimeType) ? "UTF-8" : null, inputStreamOpen);
                } catch (IOException unused) {
                }
            }
            return null;
        }

        // The app stays in the app; links, files and tel:/mailto: open outside it.
        @Override
        public boolean shouldOverrideUrlLoading(WebView webView, WebResourceRequest webResourceRequest) {
            Uri url = webResourceRequest.getUrl();
            if (MainActivity.ASSET_HOST.equals(url.getHost())) {
                return false;
            }
            if (webResourceRequest.isForMainFrame()) openOutside(url);
            return true;
        }

        @Override
        public void onPageFinished(WebView webView, String str) {
            super.onPageFinished(webView, str);
            MainActivity.this.hideSplash();
        }
    }

    private void readMetaData() {
        try {
            Bundle bundle = getPackageManager().getApplicationInfo(getPackageName(), 128).metaData;
            if (bundle != null) {
                this.backButtonMode = bundle.getString("nitron.backButton", "history");
                this.clearCacheOnStart = bundle.getBoolean("nitron.clearCacheOnStart", false);
            }
        } catch (PackageManager.NameNotFoundException unused) {
        }
    }

    private void setupSplashScreen() {
        String string;
        String str = "#FFFFFF";
        try {
            Bundle bundle = getPackageManager().getApplicationInfo(getPackageName(), 128).metaData;
            if (bundle != null && (string = bundle.getString("nitron.splashBackground", "#FFFFFF")) != null && !string.isEmpty()) {
                str = string;
            }
        } catch (PackageManager.NameNotFoundException unused) {
        }
        View view = new View(this);
        this.splashView = view;
        try {
            view.setBackgroundColor(Color.parseColor(str));
        } catch (IllegalArgumentException unused2) {
            this.splashView.setBackgroundColor(-1);
        }
        this.rootLayout.addView(this.splashView, new FrameLayout.LayoutParams(-1, -1));
    }

    public void hideSplash() {
        View view = this.splashView;
        if (view == null || view.getVisibility() != 0) {
            return;
        }
        AlphaAnimation alphaAnimation = new AlphaAnimation(1.0f, 0.0f);
        alphaAnimation.setDuration(300L);
        alphaAnimation.setFillAfter(true);
        this.splashView.startAnimation(alphaAnimation);
        this.splashView.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (MainActivity.this.splashView != null) {
                    MainActivity.this.splashView.setVisibility(8);
                    MainActivity.this.rootLayout.removeView(MainActivity.this.splashView);
                    MainActivity.this.splashView = null;
                }
            }
        }, 300L);
    }

    @Override
    public void onBackPressed() {
        WebView webView;
        if ("history".equals(this.backButtonMode) && (webView = this.webView) != null && webView.canGoBack()) {
            this.webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (this.callAudio != null) {
            this.callAudio.stop();
        }
        WebView webView = this.webView;
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }

    public static String resolveMimeType(String str) {
        if (str == null || str.isEmpty()) {
            return "application/octet-stream";
        }
        int iLastIndexOf = str.lastIndexOf(46);
        if (iLastIndexOf == -1) {
            return "application/octet-stream";
        }
        switch (str.substring(iLastIndexOf + 1).toLowerCase()) {
            case "js":
            case "mjs":
                return "application/javascript";
            case "css":
                return "text/css";
            case "eot":
                return "application/vnd.ms-fontobject";
            case "gif":
                return "image/gif";
            case "htm":
            case "html":
                return "text/html";
            case "ico":
                return "image/x-icon";
            case "jpg":
            case "jpeg":
                return "image/jpeg";
            case "map":
                return "application/json";
            case "mp3":
                return "audio/mpeg";
            case "mp4":
                return "video/mp4";
            case "ogg":
                return "audio/ogg";
            case "otf":
                return "font/otf";
            case "pdf":
                return "application/pdf";
            case "png":
                return "image/png";
            case "svg":
                return "image/svg+xml";
            case "ttf":
                return "font/ttf";
            case "txt":
                return "text/plain";
            case "wav":
                return "audio/wav";
            case "xml":
                return "application/xml";
            case "avif":
                return "image/avif";
            case "json":
            case "webmanifest":
                return "application/json";
            case "wasm":
                return "application/wasm";
            case "webm":
                return "video/webm";
            case "webp":
                return "image/webp";
            case "woff":
                return "font/woff";
            case "woff2":
                return "font/woff2";
            default:
                return "application/octet-stream";
        }
    }

    public static boolean isTextMimeType(String str) {
        return str != null && (str.startsWith("text/") || str.equals("application/javascript") || str.equals("application/json") || str.equals("application/xml") || str.equals("image/svg+xml") || str.equals("application/wasm"));
    }

    private class NitronJSInterface {
        private NitronJSInterface() {
        }

        @JavascriptInterface
        public void showNotification(String str, String str2) {
            PendingIntent activity;
            Notification.Builder builder;
            NotificationManager notificationManager = (NotificationManager) MainActivity.this.getSystemService("notification");
            if (Build.VERSION.SDK_INT >= 26) {
                notificationManager.createNotificationChannel(new NotificationChannel("nitron_default_channel", "Default Notifications", 3));
            }
            Intent intent = new Intent(MainActivity.this, MainActivity.class);
            intent.setFlags(268468224);
            if (Build.VERSION.SDK_INT >= 31) {
                activity = PendingIntent.getActivity(MainActivity.this, 0, intent, 67108864);
            } else {
                activity = PendingIntent.getActivity(MainActivity.this, 0, intent, 134217728);
            }
            if (Build.VERSION.SDK_INT >= 26) {
                builder = new Notification.Builder(MainActivity.this, "nitron_default_channel");
            } else {
                builder = new Notification.Builder(MainActivity.this);
            }
            builder.setSmallIcon(MainActivity.this.getApplicationInfo().icon).setContentTitle(str).setContentText(str2).setAutoCancel(true).setContentIntent(activity);
            notificationManager.notify((int) System.currentTimeMillis(), builder.build());
        }

        @JavascriptInterface
        public void requestLocationPermission() {
            MainActivity.this.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (Build.VERSION.SDK_INT >= 23) {
                        MainActivity.this.requestPermissions(new String[] {"android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION"}, 101);
                    }
                }
            });
        }

        @JavascriptInterface
        public void requestCameraPermission() {
            MainActivity.this.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (Build.VERSION.SDK_INT >= 23) {
                        MainActivity.this.requestPermissions(new String[] {"android.permission.CAMERA", "android.permission.RECORD_AUDIO"}, 102);
                    }
                }
            });
        }

        @JavascriptInterface
        public void requestStoragePermission() {
            MainActivity.this.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (Build.VERSION.SDK_INT >= 33) {
                        MainActivity.this.requestPermissions(new String[] {"android.permission.READ_MEDIA_IMAGES", "android.permission.READ_MEDIA_VIDEO"}, 103);
                    } else if (Build.VERSION.SDK_INT >= 23) {
                        MainActivity.this.requestPermissions(new String[] {"android.permission.READ_EXTERNAL_STORAGE", "android.permission.WRITE_EXTERNAL_STORAGE"}, 103);
                    }
                }
            });
        }
    }
}
