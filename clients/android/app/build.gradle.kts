plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val matchaAssets = layout.buildDirectory.dir("generated/matcha/assets")
val sherpaAar = layout.buildDirectory.file("dependencies/sherpa-onnx.aar")
val prepareMatcha by tasks.registering(Exec::class) {
    val script = rootProject.file("prepare_matcha.py")
    val speechSources = rootProject.projectDir.resolve("../../turnline")
    inputs.files(script, speechSources.resolve("setup_models.py"), speechSources.resolve("pronunciation.py"))
    outputs.dir(matchaAssets)
    outputs.file(sherpaAar)
    val defaultPython = if (System.getProperty("os.name").startsWith("Windows")) "python" else "python3"
    commandLine(providers.gradleProperty("matchaPython").getOrElse(defaultPython), script,
        sherpaAar.get().asFile, matchaAssets.get().asFile)
}

android {
    namespace = "dev.turnline.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.turnline.android"
        minSdk = 31
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
    }

    buildFeatures {
        compose = true
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    sourceSets["main"].assets.srcDir(matchaAssets)
    androidResources.noCompress += "onnx"
    packaging.jniLibs.useLegacyPackaging = true

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

tasks.named("preBuild") { dependsOn(prepareMatcha) }

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

dependencies {
    implementation(files(sherpaAar).builtBy(prepareMatcha))
    implementation(platform("androidx.compose:compose-bom:2025.05.01"))
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.1")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250107")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}
