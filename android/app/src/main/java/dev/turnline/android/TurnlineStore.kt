package dev.turnline.android

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class TurnlineStore(context: Context) : SQLiteOpenHelper(context, "turnline.db", null, 1) {
    private val prefs = context.getSharedPreferences("turnline", Context.MODE_PRIVATE)
    private val vault = KeyVault()

    init {
        setWriteAheadLoggingEnabled(true)
    }

    override fun onConfigure(db: SQLiteDatabase) {
        db.setForeignKeyConstraintsEnabled(true)
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("""
            CREATE TABLE conversations (
                id TEXT PRIMARY KEY NOT NULL,
                scope TEXT NOT NULL,
                title TEXT NOT NULL,
                updated INTEGER NOT NULL,
                remote_id TEXT,
                cursor TEXT
            )
        """.trimIndent())
        db.execSQL("CREATE INDEX conversations_scope ON conversations(scope, updated DESC)")
        db.execSQL("""
            CREATE TABLE messages (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT UNIQUE NOT NULL,
                thread TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                role TEXT NOT NULL,
                text TEXT NOT NULL,
                delivery TEXT NOT NULL,
                remote_id TEXT,
                UNIQUE(thread, remote_id)
            )
        """.trimIndent())
        db.execSQL("CREATE INDEX messages_thread ON messages(thread, sequence)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        error("Missing database migration from $oldVersion to $newVersion")
    }

    fun settings(): ServiceSettings? {
        val url = prefs.getString("url", null) ?: return null
        return ServiceSettings(
            provider = Provider.valueOf(prefs.getString("provider", Provider.PIPICLAW.name)!!),
            url = responsesUrl(url),
            model = prefs.getString("model", "pipiclaw").orEmpty(),
            key = prefs.getString("credential", null)?.let(vault::decrypt).orEmpty(),
            language = SpeechLanguage.valueOf(prefs.getString("language", SpeechLanguage.CHINESE.name)!!),
            localRecognition = prefs.getBoolean("local_recognition", true)
        )
    }

    fun saveSettings(settings: ServiceSettings) {
        val editor = prefs.edit().putString("provider", settings.provider.name)
            .putString("url", settings.url.toString()).putString("model", settings.model)
            .putString("language", settings.language.name).putBoolean("local_recognition", settings.localRecognition)
        if (settings.key.isEmpty()) editor.remove("credential")
        else editor.putString("credential", vault.encrypt(settings.key))
        check(editor.commit())
    }

    fun scope(settings: ServiceSettings): String = vault.identifier(
        listOf(settings.provider.name, settings.url.toString(), settings.model, settings.key).joinToString("\u0000")
    )

    fun lastThread(scope: String): String? = prefs.getString("thread_$scope", null)

    fun rememberThread(scope: String, id: String?) {
        prefs.edit().putString("thread_$scope", id ?: "").apply()
    }

    fun recoverPending() {
        writableDatabase.update(
            "messages", ContentValues().apply { put("delivery", Delivery.STOPPED.name) },
            "delivery = ?", arrayOf(Delivery.PENDING.name)
        )
    }

    fun conversations(scope: String): List<Conversation> = readableDatabase.rawQuery(
        "SELECT id, title, remote_id, cursor FROM conversations WHERE scope = ? ORDER BY updated DESC LIMIT 100",
        arrayOf(scope)
    ).use { cursor ->
        buildList {
            while (cursor.moveToNext()) add(Conversation(
                id = cursor.getString(0), title = cursor.getString(1),
                remoteId = cursor.optionalString(2), cursor = cursor.optionalString(3)
            ))
        }
    }

    fun messages(thread: String): List<Message> = readableDatabase.rawQuery(
        """
        SELECT id, role, text, delivery, remote_id FROM (
            SELECT * FROM messages WHERE thread = ? ORDER BY sequence DESC LIMIT $TRANSCRIPT_LIMIT
        ) ORDER BY sequence ASC
        """.trimIndent(), arrayOf(thread)
    ).use { cursor ->
        buildList {
            while (cursor.moveToNext()) add(Message(
                id = cursor.getString(0), role = Role.valueOf(cursor.getString(1)), text = cursor.getString(2),
                delivery = Delivery.valueOf(cursor.getString(3)), remoteId = cursor.optionalString(4)
            ))
        }
    }

    fun startTurn(scope: String, thread: Conversation, message: Message, time: Long) = transaction { db ->
        val metadata = ContentValues().apply {
            put("id", thread.id)
            put("scope", scope)
            put("title", thread.title)
            put("updated", time)
        }
        val inserted = db.insertWithOnConflict("conversations", null, metadata, SQLiteDatabase.CONFLICT_IGNORE)
        if (inserted == -1L) touch(db, thread.id, time)
        insert(db, thread.id, message)
    }

    fun setRemoteId(thread: String, id: String) {
        writableDatabase.update("conversations", ContentValues().apply { put("remote_id", id) },
            "id = ?", arrayOf(thread))
    }

    fun finishTurn(thread: String, user: String, delivery: Delivery, answers: List<Message>) = transaction { db ->
        db.update("messages", ContentValues().apply { put("delivery", delivery.name) }, "id = ?", arrayOf(user))
        answers.forEach { insert(db, thread, it) }
    }

    fun applyPage(thread: String, page: ConversationPage) = transaction { db ->
        var arrived = false
        for (answer in page.messages) {
            val remoteId = answer.id ?: continue
            val existing = db.rawQuery("SELECT id, delivery FROM messages WHERE thread = ? AND remote_id = ?",
                arrayOf(thread, remoteId)).use { result ->
                if (result.moveToFirst()) result.getString(0) to result.getString(1) else null
            }
            if (existing?.second == Delivery.COMPLETE.name) continue
            val message = Message(id = existing?.first ?: java.util.UUID.randomUUID().toString(),
                role = Role.ASSISTANT, text = answer.text, remoteId = remoteId)
            if (existing == null) {
                insert(db, thread, message)
            } else {
                db.update("messages", ContentValues().apply {
                    put("text", message.text)
                    put("delivery", Delivery.COMPLETE.name)
                }, "id = ?", arrayOf(message.id))
            }
            arrived = true
        }
        db.update("conversations", ContentValues().apply { put("cursor", page.cursor) }, "id = ?", arrayOf(thread))
        if (arrived) touch(db, thread, System.currentTimeMillis())
    }

    fun delete(thread: String) {
        writableDatabase.delete("conversations", "id = ?", arrayOf(thread))
    }

    private fun insert(db: SQLiteDatabase, thread: String, message: Message) {
        db.insertOrThrow("messages", null, ContentValues().apply {
            put("id", message.id)
            put("thread", thread)
            put("role", message.role.name)
            put("text", message.text)
            put("delivery", message.delivery.name)
            put("remote_id", message.remoteId)
        })
    }

    private fun touch(db: SQLiteDatabase, thread: String, time: Long) {
        db.update("conversations", ContentValues().apply { put("updated", time) }, "id = ?", arrayOf(thread))
    }

    private inline fun <T> transaction(block: (SQLiteDatabase) -> T): T {
        val db = writableDatabase
        db.beginTransactionNonExclusive()
        try {
            val result = block(db)
            db.setTransactionSuccessful()
            return result
        } finally {
            db.endTransaction()
        }
    }
}

private fun Cursor.optionalString(index: Int): String? = if (isNull(index)) null else getString(index)

private class KeyVault {
    private val alias = "turnline-api-key"
    private val algorithm = "AES/GCM/NoPadding"

    fun encrypt(value: String): String {
        val cipher = Cipher.getInstance(algorithm).apply { init(Cipher.ENCRYPT_MODE, key(create = true)) }
        val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(cipher.iv + encrypted, Base64.NO_WRAP)
    }

    fun decrypt(value: String): String {
        val bytes = Base64.decode(value, Base64.NO_WRAP)
        val cipher = Cipher.getInstance(algorithm).apply {
            init(Cipher.DECRYPT_MODE, key(create = false), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        }
        return cipher.doFinal(bytes, 12, bytes.size - 12).toString(Charsets.UTF_8)
    }

    fun identifier(value: String): String {
        val alias = "turnline-service-scope"
        val algorithm = KeyProperties.KEY_ALGORITHM_HMAC_SHA256
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val key = (store.getKey(alias, null) as? SecretKey) ?: KeyGenerator.getInstance(algorithm, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN).build())
            generateKey()
        }
        return Mac.getInstance(algorithm).run {
            init(key)
            Base64.encodeToString(doFinal(value.toByteArray(Charsets.UTF_8)), Base64.URL_SAFE or Base64.NO_WRAP)
        }
    }

    private fun key(create: Boolean): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        check(create)
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build())
            generateKey()
        }
    }
}
