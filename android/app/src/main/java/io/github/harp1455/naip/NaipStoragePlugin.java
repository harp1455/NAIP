package io.github.harp1455.naip;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteCursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteProgram;
import android.database.sqlite.SQLiteStatement;
import android.net.Uri;
import android.os.Environment;
import android.os.StatFs;
import android.provider.MediaStore;
import android.util.Base64;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * 히스토리 저장소 (src/storage/native.ts 와 짝):
 * - SQLite: 앱 전용 DB(databases/naip-history.db, WAL). 매개변수는 타입대로 묶고, batch는 한 트랜잭션.
 *   DB 작업은 한 줄로 세운 전용 스레드에서만 한다 — 메인 스레드·Capacitor 플러그인 스레드를 막지 않고, 순서가 지켜진다.
 * - 파일: files/images(원본), files/thumbs(썸네일), files/queue(대기열). 임시 파일에 쓰고 동기화한 뒤 이름을 바꾼다.
 *   웹뷰는 Capacitor.convertFileSrc 주소로 바로 읽는다 (base64 왕복 없음).
 * - 갤러리 저장·클립보드 복사·공유 준비를 파일에서 바로 한다.
 * - 저장 공간: StatFs로 남은 공간(freeBytes), 앱이 쓰는 크기(storageInfo), 캐시 비우기.
 */
@CapacitorPlugin(name = "NaipStorage")
public class NaipStoragePlugin extends Plugin {

    private static final String DB_NAME = "naip-history.db";
    private final ExecutorService dbExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService fileExecutor = Executors.newFixedThreadPool(2);
    private SQLiteDatabase db;

    private SQLiteDatabase db() {
        if (db == null || !db.isOpen()) {
            File file = getContext().getDatabasePath(DB_NAME);
            File parent = file.getParentFile();
            if (parent != null && !parent.exists()) parent.mkdirs();
            db = SQLiteDatabase.openDatabase(
                file.getPath(),
                null,
                SQLiteDatabase.CREATE_IF_NECESSARY | SQLiteDatabase.ENABLE_WRITE_AHEAD_LOGGING
            );
        }
        return db;
    }

    @Override
    protected void handleOnDestroy() {
        dbExecutor.execute(() -> {
            if (db != null && db.isOpen()) db.close();
        });
    }

    // ── SQL ────────────────────────────────────────────────

    @PluginMethod
    public void open(PluginCall call) {
        dbExecutor.execute(() -> {
            try {
                SQLiteDatabase d = db();
                JSObject out = new JSObject();
                out.put("filesDir", getContext().getFilesDir().getAbsolutePath());
                out.put("dbPath", d.getPath());
                call.resolve(out);
            } catch (Exception e) {
                call.reject("open failed: " + e.getMessage(), e);
            }
        });
    }

    /** JS 값 → 타입대로 묶기 (정수는 long, 소수는 double, 문자열, null) */
    private static void bindAll(SQLiteProgram program, JSONArray params) throws JSONException {
        if (params == null) return;
        for (int i = 0; i < params.length(); i++) {
            Object v = params.get(i);
            int index = i + 1;
            if (v == null || v == JSONObject.NULL) program.bindNull(index);
            else if (v instanceof Integer || v instanceof Long || v instanceof Short || v instanceof Byte) program.bindLong(
                index,
                ((Number) v).longValue()
            );
            else if (v instanceof Number) {
                double d = ((Number) v).doubleValue();
                if (d == Math.rint(d) && Math.abs(d) < 9.0e15) program.bindLong(index, (long) d);
                else program.bindDouble(index, d);
            } else if (v instanceof Boolean) program.bindLong(index, ((Boolean) v) ? 1 : 0);
            else program.bindString(index, v.toString());
        }
    }

    private static String head(String sql) {
        String s = sql.trim();
        int end = 0;
        while (end < s.length() && Character.isLetter(s.charAt(end))) end++;
        return s.substring(0, end).toUpperCase(Locale.ROOT);
    }

    /** 문장 하나 실행 → 바뀐 행 수 */
    private static int run(SQLiteDatabase d, String sql, JSONArray params) throws JSONException {
        String h = head(sql);
        if (h.equals("INSERT") || h.equals("REPLACE") || h.equals("UPDATE") || h.equals("DELETE")) {
            SQLiteStatement st = d.compileStatement(sql);
            try {
                bindAll(st, params);
                return st.executeUpdateDelete();
            } finally {
                st.close();
            }
        }
        // CREATE·PRAGMA 설정 등 — 행을 돌려주지 않는 그 밖의 문장
        if (params == null || params.length() == 0) d.execSQL(sql);
        else {
            SQLiteStatement st = d.compileStatement(sql);
            try {
                bindAll(st, params);
                st.execute();
            } finally {
                st.close();
            }
        }
        return 0;
    }

    @PluginMethod
    public void query(PluginCall call) {
        String sql = call.getString("sql");
        JSArray params = call.getArray("params", new JSArray());
        if (sql == null) {
            call.reject("sql is required");
            return;
        }
        dbExecutor.execute(() -> {
            Cursor c = null;
            try {
                // rawQuery는 문자열로만 묶으므로, Room처럼 커서 팩토리에서 타입대로 다시 묶는다
                c = db().rawQueryWithFactory(
                    (database, driver, editTable, q) -> {
                        try {
                            bindAll(q, params);
                        } catch (JSONException e) {
                            throw new IllegalArgumentException(e);
                        }
                        return new SQLiteCursor(driver, editTable, q);
                    },
                    sql,
                    null,
                    null
                );
                String[] names = c.getColumnNames();
                JSArray columns = new JSArray();
                for (String n : names) columns.put(n);
                JSArray rows = new JSArray();
                while (c.moveToNext()) {
                    JSONArray row = new JSONArray();
                    for (int i = 0; i < names.length; i++) {
                        switch (c.getType(i)) {
                            case Cursor.FIELD_TYPE_NULL:
                                row.put(JSONObject.NULL);
                                break;
                            case Cursor.FIELD_TYPE_INTEGER:
                                row.put(c.getLong(i));
                                break;
                            case Cursor.FIELD_TYPE_FLOAT:
                                row.put(c.getDouble(i));
                                break;
                            case Cursor.FIELD_TYPE_BLOB:
                                row.put(Base64.encodeToString(c.getBlob(i), Base64.NO_WRAP));
                                break;
                            default:
                                row.put(c.getString(i));
                        }
                    }
                    rows.put(row);
                }
                JSObject out = new JSObject();
                out.put("columns", columns);
                out.put("rows", rows);
                call.resolve(out);
            } catch (Exception e) {
                call.reject("query failed: " + e.getMessage(), e);
            } finally {
                if (c != null) c.close();
            }
        });
    }

    @PluginMethod
    public void exec(PluginCall call) {
        String sql = call.getString("sql");
        JSArray params = call.getArray("params", new JSArray());
        if (sql == null) {
            call.reject("sql is required");
            return;
        }
        dbExecutor.execute(() -> {
            try {
                int changes = run(db(), sql, params);
                JSObject out = new JSObject();
                out.put("changes", changes);
                call.resolve(out);
            } catch (Exception e) {
                call.reject("exec failed: " + e.getMessage(), e);
            }
        });
    }

    /** 여러 문장을 한 트랜잭션으로 — 하나라도 실패하면 모두 되돌린다 */
    @PluginMethod
    public void batch(PluginCall call) {
        JSArray statements = call.getArray("statements", new JSArray());
        dbExecutor.execute(() -> {
            SQLiteDatabase d;
            try {
                d = db();
            } catch (Exception e) {
                call.reject("open failed: " + e.getMessage(), e);
                return;
            }
            d.beginTransactionNonExclusive();
            try {
                for (int i = 0; i < statements.length(); i++) {
                    JSONObject s = statements.getJSONObject(i);
                    run(d, s.getString("sql"), s.optJSONArray("params"));
                }
                d.setTransactionSuccessful();
            } catch (Exception e) {
                d.endTransaction();
                call.reject("batch failed: " + e.getMessage(), e);
                return;
            }
            try {
                d.endTransaction();
                call.resolve();
            } catch (Exception e) {
                call.reject("commit failed: " + e.getMessage(), e);
            }
        });
    }

    // ── 파일 ────────────────────────────────────────────────

    /** 앱 전용 폴더 안의 상대 경로만 받는다 (.. 로 밖을 가리키면 거절) */
    private File resolve(String path) throws IOException {
        if (path == null || path.isEmpty() || path.startsWith("/")) throw new IOException("bad path: " + path);
        File root = getContext().getFilesDir().getCanonicalFile();
        File f = new File(root, path).getCanonicalFile();
        if (!f.getPath().startsWith(root.getPath() + File.separator)) throw new IOException("path outside app files: " + path);
        return f;
    }

    @PluginMethod
    public void writeFile(PluginCall call) {
        String path = call.getString("path");
        String base64 = call.getString("base64");
        if (path == null || base64 == null) {
            call.reject("path and base64 are required");
            return;
        }
        fileExecutor.execute(() -> {
            try {
                File target = resolve(path);
                File dir = target.getParentFile();
                if (dir != null && !dir.exists() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                // 임시 파일에 다 쓰고 디스크에 내린 뒤 이름을 바꾼다 — 중간에 죽어도 반쯤 쓴 파일이 원본 이름으로 남지 않는다
                File tmp = new File(dir, target.getName() + ".tmp");
                try (FileOutputStream out = new FileOutputStream(tmp)) {
                    out.write(bytes);
                    out.getFD().sync();
                }
                if (!tmp.renameTo(target)) {
                    tmp.delete();
                    throw new IOException("rename failed: " + path);
                }
                JSObject out = new JSObject();
                out.put("size", target.length());
                call.resolve(out);
            } catch (Exception e) {
                call.reject("write failed: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void fileSizes(PluginCall call) {
        JSArray paths = call.getArray("paths", new JSArray());
        fileExecutor.execute(() -> {
            try {
                JSArray sizes = new JSArray();
                for (int i = 0; i < paths.length(); i++) {
                    File f = resolve(paths.getString(i));
                    sizes.put(f.isFile() ? f.length() : -1);
                }
                JSObject out = new JSObject();
                out.put("sizes", sizes);
                call.resolve(out);
            } catch (Exception e) {
                call.reject("stat failed: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void deleteFiles(PluginCall call) {
        JSArray paths = call.getArray("paths", new JSArray());
        fileExecutor.execute(() -> {
            try {
                for (int i = 0; i < paths.length(); i++) {
                    File f = resolve(paths.getString(i));
                    if (f.isFile()) f.delete();
                }
                call.resolve();
            } catch (Exception e) {
                call.reject("delete failed: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void listFiles(PluginCall call) {
        String dir = call.getString("dir", "");
        fileExecutor.execute(() -> {
            try {
                File d = resolve(dir);
                JSArray files = new JSArray();
                File[] list = d.listFiles();
                if (list != null) {
                    for (File f : list) {
                        if (!f.isFile()) continue;
                        JSObject o = new JSObject();
                        o.put("name", f.getName());
                        o.put("size", f.length());
                        files.put(o);
                    }
                }
                JSObject out = new JSObject();
                out.put("files", files);
                call.resolve(out);
            } catch (Exception e) {
                call.reject("list failed: " + e.getMessage(), e);
            }
        });
    }

    private static long sizeOf(File f) {
        if (f == null || !f.exists()) return 0;
        if (f.isFile()) return f.length();
        long total = 0;
        File[] list = f.listFiles();
        if (list != null) for (File c : list) total += sizeOf(c);
        return total;
    }

    /** 남은 공간만 (폴더를 훑지 않아 빠르다 — 생성 전·옮기는 중에 자주 부른다) */
    @PluginMethod
    public void freeBytes(PluginCall call) {
        fileExecutor.execute(() -> {
            try {
                StatFs stat = new StatFs(getContext().getFilesDir().getPath());
                JSObject out = new JSObject();
                out.put("free", stat.getAvailableBytes());
                call.resolve(out);
            } catch (Exception e) {
                call.reject("statfs failed: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void storageInfo(PluginCall call) {
        fileExecutor.execute(() -> {
            try {
                File files = getContext().getFilesDir();
                StatFs stat = new StatFs(files.getPath());
                File dbFile = getContext().getDatabasePath(DB_NAME);
                long dbBytes =
                    sizeOf(dbFile) + sizeOf(new File(dbFile.getPath() + "-wal")) + sizeOf(new File(dbFile.getPath() + "-shm"));
                JSObject out = new JSObject();
                out.put("free", stat.getAvailableBytes());
                out.put("total", stat.getTotalBytes());
                out.put("dbBytes", dbBytes);
                out.put("imagesBytes", sizeOf(new File(files, "images")));
                out.put("thumbsBytes", sizeOf(new File(files, "thumbs")));
                out.put("cacheBytes", sizeOf(getContext().getCacheDir()));
                call.resolve(out);
            } catch (Exception e) {
                call.reject("storage info failed: " + e.getMessage(), e);
            }
        });
    }

    private static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] list = f.listFiles();
        if (list != null) for (File c : list) deleteTree(c);
        f.delete();
    }

    /** 앱이 만든 캐시(공유·클립보드 사본, 받은 업데이트)와 웹뷰 HTTP 캐시를 비운다. 원본·썸네일은 files에 있어 건드리지 않는다 */
    @PluginMethod
    public void clearCache(PluginCall call) {
        fileExecutor.execute(() -> {
            File cache = getContext().getCacheDir();
            long before = sizeOf(cache);
            for (String name : new String[] { "share", "clipboard", "updates" }) deleteTree(new File(cache, name));
            getActivity()
                .runOnUiThread(() -> {
                    getBridge().getWebView().clearCache(true);
                    fileExecutor.execute(() -> {
                        JSObject out = new JSObject();
                        out.put("freed", Math.max(0, before - sizeOf(cache)));
                        call.resolve(out);
                    });
                });
        });
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[65536];
        for (int n; (n = in.read(buf)) > 0;) out.write(buf, 0, n);
    }

    /** 파일을 그대로 Pictures/NAIP[/폴더] 에 복사한다 (NaipNativePlugin.saveToGallery와 같은 MediaStore 규칙) */
    @PluginMethod
    public void saveFileToGallery(PluginCall call) {
        String path = call.getString("path");
        String fileName = call.getString("fileName");
        String mimeType = call.getString("mimeType", "image/png");
        String folder = call.getString("folder");
        if (path == null || fileName == null) {
            call.reject("path and fileName are required");
            return;
        }
        fileExecutor.execute(() -> {
            ContentResolver resolver = getContext().getContentResolver();
            Uri uri = null;
            try {
                File src = resolve(path);
                if (!src.isFile()) throw new IOException("원본 파일이 없습니다");
                ContentValues values = new ContentValues();
                values.put(MediaStore.Images.Media.DISPLAY_NAME, fileName);
                values.put(MediaStore.Images.Media.MIME_TYPE, mimeType);
                values.put(
                    MediaStore.Images.Media.RELATIVE_PATH,
                    Environment.DIRECTORY_PICTURES + "/NAIP" + (folder != null && !folder.isEmpty() ? "/" + folder : "")
                );
                values.put(MediaStore.Images.Media.IS_PENDING, 1);
                uri = resolver.insert(MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values);
                if (uri == null) throw new IOException("MediaStore insert failed");
                try (InputStream in = new FileInputStream(src); OutputStream out = resolver.openOutputStream(uri)) {
                    if (out == null) throw new IOException("cannot open output stream");
                    copy(in, out);
                }
                values.clear();
                values.put(MediaStore.Images.Media.IS_PENDING, 0);
                resolver.update(uri, values, null, null);
                JSObject out = new JSObject();
                out.put("uri", uri.toString());
                call.resolve(out);
            } catch (Exception e) {
                if (uri != null) resolver.delete(uri, null, null);
                call.reject("save failed: " + e.getMessage(), e);
            }
        });
    }

    /** 파일을 캐시에 복사해 그 content:// 주소를 클립보드에 올린다 (NaipNativePlugin.copyImage와 같은 방식) */
    @PluginMethod
    public void copyImageFile(PluginCall call) {
        String path = call.getString("path");
        String mimeType = call.getString("mimeType", "image/png");
        fileExecutor.execute(() -> {
            try {
                File src = resolve(path);
                if (!src.isFile()) throw new IOException("원본 파일이 없습니다");
                File dir = new File(getContext().getCacheDir(), "clipboard");
                if (!dir.exists() && !dir.mkdirs()) throw new IOException("cannot create cache dir");
                // 이전에 복사한 파일은 지운다 (붙여 넣는 앱이 읽는 중일 수 있어 가장 최근 것은 남긴다)
                File[] old = dir.listFiles();
                if (old != null && old.length > 1) {
                    java.util.Arrays.sort(old, (a, b) -> Long.compare(b.lastModified(), a.lastModified()));
                    for (int i = 1; i < old.length; i++) old[i].delete();
                }
                String ext = "image/webp".equals(mimeType) ? ".webp" : ".png";
                File file = new File(dir, "NAIP_" + System.currentTimeMillis() + ext);
                try (InputStream in = new FileInputStream(src); OutputStream out = new FileOutputStream(file)) {
                    copy(in, out);
                }
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
                ClipData clip = ClipData.newUri(getContext().getContentResolver(), "NAIP image", uri);
                ClipboardManager clipboard = getContext().getSystemService(ClipboardManager.class);
                if (clipboard == null) throw new IllegalStateException("clipboard unavailable");
                clipboard.setPrimaryClip(clip);
                call.resolve();
            } catch (Exception e) {
                call.reject("copy failed: " + e.getMessage(), e);
            }
        });
    }

    /** 공유할 파일을 보기 좋은 이름으로 캐시(share/)에 복사하고 file:// 주소를 돌려준다 (Share 플러그인이 FileProvider로 넘긴다) */
    @PluginMethod
    public void prepareShare(PluginCall call) {
        JSArray items = call.getArray("items", new JSArray());
        fileExecutor.execute(() -> {
            try {
                File dir = new File(getContext().getCacheDir(), "share");
                if (!dir.exists() && !dir.mkdirs()) throw new IOException("cannot create cache dir");
                JSArray uris = new JSArray();
                for (int i = 0; i < items.length(); i++) {
                    JSONObject item = items.getJSONObject(i);
                    File src = resolve(item.getString("path"));
                    if (!src.isFile()) throw new IOException("원본 파일이 없습니다");
                    String name = new File(item.getString("name")).getName();
                    File dest = new File(dir, name);
                    try (InputStream in = new FileInputStream(src); OutputStream out = new FileOutputStream(dest)) {
                        copy(in, out);
                    }
                    uris.put(Uri.fromFile(dest).toString());
                }
                JSObject out = new JSObject();
                out.put("uris", uris);
                call.resolve(out);
            } catch (Exception e) {
                call.reject("share failed: " + e.getMessage(), e);
            }
        });
    }
}
