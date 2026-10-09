package com.nicron.webview;

import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputConnectionWrapper;
import android.view.inputmethod.InputContentInfo;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The app's WebView, plus pictures sent from the phone's keyboard (an image in
 * Gboard's clipboard, a GIF or a sticker). A plain WebView tells the keyboard
 * it can't take images ("doesn't support image insertion here"); this one
 * accepts them and tells the page with a "chaty-keyboard-image" event whose
 * URL the page fetches once.
 */
final class ChatyWebView extends WebView {
    private static final String TAG = "ChatyWebView";
    static final String KEYBOARD_PATH = "/__keyboard/";
    private static final int MAX_BYTES = 50 << 20;

    // token -> {mime type, bytes}, until the page fetches it
    private final ConcurrentHashMap<String, Object[]> received = new ConcurrentHashMap<>();
    private int counter;

    ChatyWebView(Context context) {
        super(context);
    }

    @Override
    public InputConnection onCreateInputConnection(EditorInfo outAttrs) {
        InputConnection ic = super.onCreateInputConnection(outAttrs);
        if (ic == null || Build.VERSION.SDK_INT < 25) return ic;
        outAttrs.contentMimeTypes = new String[] {"image/*"};
        return new InputConnectionWrapper(ic, false) {
            @Override
            public boolean commitContent(InputContentInfo info, int flags, Bundle opts) {
                return receive(info, flags);
            }
        };
    }

    private boolean receive(final InputContentInfo info, int flags) {
        try {
            if ((flags & InputConnection.INPUT_CONTENT_GRANT_READ_URI_PERMISSION) != 0) info.requestPermission();
        } catch (Exception e) {
            Log.w(TAG, "permission", e);
            return false;
        }
        final String mime = info.getDescription().getMimeTypeCount() > 0
                ? info.getDescription().getMimeType(0).replaceAll("[^a-zA-Z0-9/+.-]", "")
                : "image/png";
        final Uri uri = info.getContentUri();
        new Thread(new Runnable() {
            @Override
            public void run() {
                byte[] data = read(uri);
                try {
                    info.releasePermission();
                } catch (Exception ignored) {
                }
                if (data == null) return;
                final String token = Long.toHexString(System.nanoTime()) + (counter++);
                received.put(token, new Object[] {mime, data});
                post(new Runnable() {
                    @Override
                    public void run() {
                        evaluateJavascript("window.dispatchEvent(new CustomEvent('chaty-keyboard-image',{detail:{url:'"
                                + KEYBOARD_PATH + token + "',type:'" + mime + "'}}))", null);
                    }
                });
            }
        }).start();
        return true;
    }

    private byte[] read(Uri uri) {
        try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
            if (in == null) return null;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[64 << 10];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > MAX_BYTES) return null;
            }
            return out.toByteArray();
        } catch (Exception e) {
            Log.w(TAG, "read", e);
            return null;
        }
    }

    /** Hands a received picture to the page, once. */
    WebResourceResponse take(String path) {
        Object[] item = received.remove(path.substring(KEYBOARD_PATH.length()));
        if (item == null) return null;
        return new WebResourceResponse((String) item[0], null, new ByteArrayInputStream((byte[]) item[1]));
    }
}
