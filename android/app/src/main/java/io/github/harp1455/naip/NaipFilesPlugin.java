package io.github.harp1455.naip;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONException;

/**
 * 백업 파일을 저장소 접근 프레임워크(SAF)로 쓰고 읽는다 (src/backup/files.ts 와 짝).
 * - createDocument → appendChunk(base64)… → closeDocument: 사용자가 고른 곳에 조각씩 바로 쓴다.
 *   쓰다 실패하거나 abortDocument 를 부르면 만든 문서를 지운다 (반쯤 쓴 백업을 남기지 않는다).
 * - openDocument → readChunk(offset, length)… → closeReader: 고른 파일의 필요한 구간만 읽는다.
 *   탐색이 안 되는 문서(클라우드 등)는 앱 캐시 아래 임시 파일로 복사해 두고 읽으며,
 *   닫거나 복사에 실패하면 지운다. 앱이 다시 뜰 때 남은 임시 파일도 지운다.
 * 큰 파일을 통째로 메모리에 올리지 않는다.
 */
@CapacitorPlugin(name = "NaipFiles")
public class NaipFilesPlugin extends Plugin {

    /** 한 번에 읽어 넘기는 최대 크기 (base64 로 웹뷰에 건너간다) */
    private static final int MAX_READ = 8 * 1024 * 1024;
    private static final String TEMP_DIR = "naip-files";

    private static final class Writer {
        final Uri uri;
        final OutputStream out;
        long written;

        Writer(Uri uri, OutputStream out) {
            this.uri = uri;
            this.out = out;
        }
    }

    private static final class Reader {
        final ParcelFileDescriptor pfd;
        final FileChannel channel;
        final RandomAccessFile raf;
        final File temp;
        final long size;

        Reader(ParcelFileDescriptor pfd, FileChannel channel, RandomAccessFile raf, File temp, long size) {
            this.pfd = pfd;
            this.channel = channel;
            this.raf = raf;
            this.temp = temp;
            this.size = size;
        }

        void close() {
            try {
                channel.close();
            } catch (IOException ignored) {}
            if (raf != null) {
                try {
                    raf.close();
                } catch (IOException ignored) {}
            }
            if (pfd != null) {
                try {
                    pfd.close();
                } catch (IOException ignored) {}
            }
            if (temp != null) {
                //noinspection ResultOfMethodCallIgnored
                temp.delete();
            }
        }
    }

    private final Map<String, Writer> writers = new ConcurrentHashMap<>();
    private final Map<String, Reader> readers = new ConcurrentHashMap<>();
    /** 활동 결과는 메인 스레드로 오므로, 열고 복사하는 일은 여기서 한다 */
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    @Override
    public void load() {
        // 지난번에 앱이 죽으며 남긴 임시 파일 정리
        deleteTree(tempDir());
    }

    @Override
    protected void handleOnDestroy() {
        for (Map.Entry<String, Writer> e : writers.entrySet()) abortWriter(e.getValue());
        writers.clear();
        for (Reader r : readers.values()) r.close();
        readers.clear();
        io.shutdown();
    }

    private File tempDir() {
        return new File(getContext().getCacheDir(), TEMP_DIR);
    }

    private static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] children = f.listFiles();
        if (children != null) for (File c : children) deleteTree(c);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private String displayName(Uri uri) {
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getString(0);
        } catch (Exception ignored) {}
        String last = uri.getLastPathSegment();
        return last == null ? "" : last;
    }

    private long querySize(Uri uri) {
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.SIZE }, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getLong(0);
        } catch (Exception ignored) {}
        return -1;
    }

    private void deleteDocument(Uri uri) {
        try {
            DocumentsContract.deleteDocument(getContext().getContentResolver(), uri);
        } catch (Exception ignored) {
            // 지우기를 지원하지 않는 저장소 — 빈(또는 쓰다 만) 파일이 남을 수 있다
        }
    }

    private void abortWriter(Writer w) {
        try {
            w.out.close();
        } catch (IOException ignored) {}
        deleteDocument(w.uri);
    }

    // ── 쓰기 ──────────────────────────────────────────────────────────────

    @PluginMethod
    public void createDocument(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("mimeType", "application/octet-stream"));
        intent.putExtra(Intent.EXTRA_TITLE, call.getString("fileName", "backup"));
        startActivityForResult(call, intent, "onCreateResult");
    }

    @ActivityCallback
    private void onCreateResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            JSObject r = new JSObject();
            r.put("cancelled", true);
            call.resolve(r);
            return;
        }
        Uri uri = data.getData();
        io.execute(() -> {
            ContentResolver resolver = getContext().getContentResolver();
            OutputStream out = null;
            try {
                // 덮어쓰기 대상이면 비우고 쓴다 ("wt" 를 모르는 저장소는 "w")
                try {
                    out = resolver.openOutputStream(uri, "wt");
                } catch (Exception e) {
                    out = resolver.openOutputStream(uri, "w");
                }
                if (out == null) throw new IOException("파일을 열 수 없습니다");
                String handle = UUID.randomUUID().toString();
                writers.put(handle, new Writer(uri, new BufferedOutputStream(out, 256 * 1024)));
                JSObject r = new JSObject();
                r.put("handle", handle);
                r.put("uri", uri.toString());
                r.put("name", displayName(uri));
                call.resolve(r);
            } catch (Exception e) {
                if (out != null) {
                    try {
                        out.close();
                    } catch (IOException ignored) {}
                }
                deleteDocument(uri);
                call.reject("파일을 만들 수 없습니다: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void appendChunk(PluginCall call) {
        String handle = call.getString("handle", "");
        Writer w = writers.get(handle);
        if (w == null) {
            call.reject("열린 파일이 없습니다");
            return;
        }
        try {
            byte[] bytes = Base64.decode(call.getString("data", ""), Base64.DEFAULT);
            w.out.write(bytes);
            w.written += bytes.length;
            JSObject r = new JSObject();
            r.put("written", w.written);
            call.resolve(r);
        } catch (Exception e) {
            // 저장 공간 부족 등 — 쓰다 만 파일을 지운다
            writers.remove(handle);
            abortWriter(w);
            call.reject("파일에 쓰지 못했습니다: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void closeDocument(PluginCall call) {
        String handle = call.getString("handle", "");
        Writer w = writers.remove(handle);
        if (w == null) {
            call.reject("열린 파일이 없습니다");
            return;
        }
        try {
            w.out.flush();
            w.out.close();
            JSObject r = new JSObject();
            r.put("size", w.written);
            call.resolve(r);
        } catch (Exception e) {
            deleteDocument(w.uri);
            call.reject("파일을 마무리하지 못했습니다: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void abortDocument(PluginCall call) {
        Writer w = writers.remove(call.getString("handle", ""));
        if (w != null) abortWriter(w);
        call.resolve();
    }

    // ── 읽기 ──────────────────────────────────────────────────────────────

    @PluginMethod
    public void openDocument(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        JSArray types = call.getArray("mimeTypes");
        if (types != null && types.length() > 0) {
            try {
                String[] list = types.toList().toArray(new String[0]);
                if (!(list.length == 1 && "*/*".equals(list[0]))) intent.putExtra(Intent.EXTRA_MIME_TYPES, list);
            } catch (JSONException ignored) {}
        }
        startActivityForResult(call, intent, "onOpenResult");
    }

    @ActivityCallback
    private void onOpenResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            JSObject r = new JSObject();
            r.put("cancelled", true);
            call.resolve(r);
            return;
        }
        Uri uri = data.getData();
        io.execute(() -> {
            try {
                Reader reader = openReader(uri);
                String handle = UUID.randomUUID().toString();
                readers.put(handle, reader);
                JSObject r = new JSObject();
                r.put("handle", handle);
                r.put("uri", uri.toString());
                r.put("name", displayName(uri));
                r.put("size", reader.size);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("파일을 열 수 없습니다: " + e.getMessage(), e);
            }
        });
    }

    /** 탐색할 수 있으면 파일 기술자를 그대로, 아니면 캐시의 임시 파일로 복사해 연다 */
    private Reader openReader(Uri uri) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        ParcelFileDescriptor pfd = null;
        try {
            pfd = resolver.openFileDescriptor(uri, "r");
            if (pfd != null) {
                FileChannel ch = new FileInputStream(pfd.getFileDescriptor()).getChannel();
                long size = ch.size();
                ch.position(0);
                if (size > 0 || querySize(uri) == 0) return new Reader(pfd, ch, null, null, size);
                ch.close();
                pfd.close();
                pfd = null;
            }
        } catch (Exception e) {
            if (pfd != null) {
                try {
                    pfd.close();
                } catch (IOException ignored) {}
            }
        }
        File dir = tempDir();
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("임시 폴더를 만들 수 없습니다");
        File temp = new File(dir, UUID.randomUUID() + ".tmp");
        try (InputStream in = resolver.openInputStream(uri); OutputStream out = new FileOutputStream(temp)) {
            if (in == null) throw new IOException("파일을 열 수 없습니다");
            byte[] buf = new byte[256 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        } catch (IOException e) {
            //noinspection ResultOfMethodCallIgnored
            temp.delete();
            throw e;
        }
        RandomAccessFile raf = new RandomAccessFile(temp, "r");
        return new Reader(null, raf.getChannel(), raf, temp, raf.length());
    }

    @PluginMethod
    public void readChunk(PluginCall call) {
        Reader r = readers.get(call.getString("handle", ""));
        if (r == null) {
            call.reject("열린 파일이 없습니다");
            return;
        }
        Double offsetValue = call.getDouble("offset");
        Integer lengthValue = call.getInt("length");
        long offset = offsetValue == null ? 0 : offsetValue.longValue();
        int length = lengthValue == null ? 0 : Math.max(0, Math.min(lengthValue, MAX_READ));
        if (offset < 0 || offset > r.size) {
            call.reject("파일 범위를 벗어난 읽기입니다");
            return;
        }
        try {
            int want = (int) Math.min(length, r.size - offset);
            ByteBuffer buf = ByteBuffer.allocate(want);
            long pos = offset;
            while (buf.hasRemaining()) {
                int n = r.channel.read(buf, pos);
                if (n < 0) break;
                pos += n;
            }
            JSObject res = new JSObject();
            res.put("data", Base64.encodeToString(buf.array(), 0, buf.position(), Base64.NO_WRAP));
            res.put("bytesRead", buf.position());
            call.resolve(res);
        } catch (Exception e) {
            call.reject("파일을 읽지 못했습니다: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void closeReader(PluginCall call) {
        Reader r = readers.remove(call.getString("handle", ""));
        if (r != null) r.close();
        call.resolve();
    }
}
