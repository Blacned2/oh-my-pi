# Kostomp Desktop Graph uygulama planı

Graph, Desktop’ta isteğe bağlı bir çalışma akışı olarak açılır. OMP her düğümün model, araç ve agent loop’unu çalıştırır. Desktop tarafındaki ayrı TypeScript süreci ise bağımlılıkları, dosya sahipliğini, denemeleri ve sonuçların doğrulanmasını yönetir. Normal sohbet, mevcut `rpc-ui` köprüsü üzerinden çalışmaya devam eder.

Kaynak kapsamı, paylaşılan konuşmadaki Planner, Context Manager, Coder, Tester, Reviewer ve deterministik Decision Gate önerisidir. Bu plan Kostomp Desktop için hazırlanmıştır. [Paylaşılan Graph konuşması](https://chatgpt.com/share/6af1c142-d63c-83eb-ac1c-301fc3ff8d41)

## Entegrasyon sınırı

- **Graph servisi** `desktop/graph/` altında ayrı bir Bun süreci olur. Scheduler, run deposu, çalışma alanları ve OMP adaptörü burada bulunur. Tauri servisin yaşam döngüsünü ve ayrı `graph_*` komutlarını yönetir. WebView sürümlü Graph olaylarını dinler ve bir snapshot ile yeniden bağlanabilir. Graph olayları sohbetin `rpc-frame` akışına girmez.
- **OMP adaptörü** mevcut paketlenmiş runtime’ı kullanarak her agent denemesi için ayrı `omp --mode rpc --no-ui` süreci açar. Mevcut `RpcClient` üzerinden `setCustomTools()` ile role özel host araçları kaydedilir. Düğüm sonucu için `promptAndWait()` ve ardından `waitForSettled()` kullanılır. Kapanış, timeout ve iptal worker’ın süreç ağacını kapsar. Protokol veya worker profili doğrulanamazsa Graph çalışmayı başlatmaz.
- **Core sınırı** `packages/`, `crates/` ve OMP RPC şeması Graph için değişmez. Yerleşik `/vibe`, `task`, plan ve goal modları Graph tarafından etkinleştirilmez. Yerleşik `task` otomatik uygulama açıldığında ebeveyn checkout’ına değişiklik taşıyabildiği için Graph yazma veya birleştirme yolu olarak kullanılmaz.
- **Worker profili** Graph işlerine özel, kullanıcı oturumundan ayrı bir profil ve çalışma dizini kullanır. Gerekli model/kimlik doğrulama yetkisi ayrı sağlanır. Uzantı, MCP, komut, skill ve proje kaynaklarının yüklenmesi mevcut desteklenen kontrollerle sınırlandırılır. İlk spike, paketlenmiş Windows sürümünde bu profilin gerçekten sadece beklenen araçları sunabildiğini ve RPC host çağrılarının çalıştığını doğrular. `--no-ui` ve uzantı allowlist’i tek başına izolasyon sağlamaz.

Dayanaklar: [Desktop RPC köprüsü](../src/rpc.rs), [runtime seçimi](../src/runtime.rs), [OMP RPC ve host araçları](../../docs/rpc.md#set_host_tools-payload), [TypeScript RPC istemcisi](../../docs/rpc.md#typescript-helper), [task izolasyonu](../../docs/tools/task.md), [uzantı yükleme](../../docs/extension-loading.md).

## Graph sözleşmesi

| Düğüm | Girdi ve çıktı |
| --- | --- |
| Planner | Kullanıcı isteği ve repo özeti → düğümler, gerçek bağımlılıklar, önerilen yazma kapsamı ve kabul kriterleri |
| Context Manager | Sabit repo snapshot’ı ve düğüm brief’i → ilgili dosya ve sembol referansları, gerekli upstream artifact’ler ve boyutu sınırlı bağlam |
| Coder | Kendi brief’i ve bağımlılık çıktıları → çalışma kopyasından host tarafından çıkarılan değişiklik seti |
| Tester | Birleştirilmiş aday snapshot → komut, exit code, süre, log referansı ve test edilen tree kimliği |
| Reviewer | Aynı aday snapshot ve kabul kriterleri → ayrı OMP oturumundan yapılandırılmış bulgular ve karar |
| Decision Gate | Adayın tree kimliği, test ve review kanıtları → `ready_to_export`, `retry`, `needs_input` veya `failed` |

Planner yalnızca öneri üretir. Scheduler şemayı, benzersiz düğüm kimliklerini, bağımlılıkları, döngüleri ve kaynak sınırlarını doğrular. MVP’de kullanıcı doğrulanmış planı başlatır. Düğümler upstream transcript’leri yerine tipli artifact referansları alır. Bir denemenin kimliği `runId/nodeId/attempt` olur. Graph döngüsüz kalır. Düzeltme gerektiğinde scheduler ilgili Coder için sınırlı yeni deneme açar, değişen çıktıya bağımlı sonuçları geçersiz kılar ve birleşik aday için test ile review’u tekrar üretir. Başarısızlık belirli bir düğüme bağlanamıyorsa run `needs_input` durumuna geçer.

## Jev ile hata yönlendirme

- **İlk kullanım** bir test hatasının `code_regression`, `flaky_test`, `environment_failure` veya `unknown` seçeneklerinden hangisine benzediğini sınıflandırmak. Örneğin JWT entegrasyon hatasında Jev bir kod regresyonu sinyali üretebilir. Scheduler ancak test ile düğüm sahipliği arasında doğrulanmış bir bağ ve kalan retry bütçesi varsa ilgili Coder’ı yeniden çalıştırır. Düşük güven, `unknown`, timeout veya sağlayıcı hatasında mevcut deterministik akış devreye girer. O akış hatayı bir düğüme bağlayamazsa run `needs_input` olur.
- **Entegrasyon** Graph sidecar’ında, OMP’nin mevcut `@oh-my-pi/pi-ai/judgment` ihracındaki `createNativeJudge()` üzerinden yapılır. Model ve kimlik bilgisi Graph yapılandırmasından çözülür. Sorular statik JSON’da `judgeQuestions()` ile tanımlanır. İlk spike paketlenmiş Windows runtime’ında istemciyi ve kimlik doğrulamayı doğrular. Hosted çağrı opt-in olur ve yalnızca ayıklanmış hata özeti ile gereken en az bağlamı gönderir. Deneme kaydında soru sürümü, model, sonuç, güven ve gecikme tutulur.
- **Karar yetkisi** scheduler ve deterministik Decision Gate’de kalır. Test sonucu, reviewer kararı, aday tree kimliği, dosya sahipliği ve retry bütçesi mevcut kurallarla doğrulanır. Jev’in yetkisi tipli bir yönlendirme sinyali üretmekle sınırlıdır. İlk aşamada sınıflandırma yalnızca kaydedilir. Geçmiş veya örnek hata vakalarında isabet, gereksiz retry ve ek gecikme ölçüldükten sonra yönlendirmede kullanılır.

[TypeSafe System One dokümanı](https://docs.typesafe.ai/concepts/system-one), [OMP judge desteği](../../docs/environment-variables.md#typesafe-judgments).

## Çakışmayı önleyen kurallar

1. **Kaynak repo salt okunur.** Run bir Git commit SHA’sına sabitlenir. MVP, kirli checkout’tan başlamayı reddeder. Graph kaynak repo dosyalarını, index’ini, refs’ini ve Git metadata’sını yazmaz. Her Coder denemesi ayrı Graph çalışma kopyasına, her Tester denemesi ayrı test kopyasına sahip olur. Çalışma kopyaları kaynak `.git` dizinine yazma erişimi paylaşmaz.
2. **Aynı dosyanın tek yazarı olur.** MVP’de paralellik okuma yapan düğümlerle sınırlıdır. Paralel Coder açıldığında scheduler normalleştirilmiş, birbirinden ayrık dosya kapsamlarını dispatch öncesi ayırır. Ortak dosyayı değiştiren işler aynı sahip altında toplanır veya plan açık bağımlılık ve yeni bir kapsam ile yeniden hazırlanır. Lockfile, ortak şema ve üretilen dosyaların sahibi ayrıca belirlenir. Host yazma araçları kapsamı her çağrıda, çıktı toplayıcı ise gerçek değişiklik setinde tekrar doğrular. Windows’ta case eşdeğerliği, `..`, reparse point/symlink ve dizin sınırı kontrol edilir. MVP, desteklenmeyen symlink ve submodule değişikliklerini reddeder.
3. **Dosyaya ve süreçlere erişimi host sınırlar.** Coder yalnızca Graph’ın dosya araçlarını alır. Serbest shell, eval, alt ajan ve harici mutasyon araçları worker’a verilmez. Test komutları yapılandırılmış izinli komutlardan seçilir. İzinli komutların çağırdığı repo kodu da çalışabildiği için test süreci, kaynak checkout’a ve diğer run’lara yazmayı OS düzeyinde engelleyen ayrı bir ortam gerektirir. Paketlenmiş Windows sürümünde bu sınır doğrulanamazsa Graph test düğümü çalışmaz ve run dışa aktarıma hazır sayılmaz.
4. **Birleştirmeyi tek koordinatör yapar.** Host, onaylanan değişiklikleri sabit tabana bağlı, tipli `baseBlob → newBlob` dosya işlemlerine dönüştürür. Bu işlemleri geçici adayda bağımlılık sırasıyla ve beklenen eski blob kimliklerini kontrol ederek uygular. Kapsam dışı çıktı veya taban uyuşmazlığı adayın tamamını reddeder. Aday hazır olduğunda Tester ve Reviewer aynı tree kimliğini doğrular. OMP’nin merkezi VCS API’si kullanılır.
5. **Teslimat ayrı bir artifact olur.** Graph başarılı adaydan `baseSha`, `treeId` ve değişiklikleri içeren bir patch üretir. Desktop kaynak checkout’a otomatik `merge`, `cherry-pick`, `stash` veya patch uygulaması yapmaz. Dışa aktarımda kaynak `HEAD` değişmişse veya checkout kirlenmişse çıktı `stale_base` olarak işaretlenir ve eski tabana ait artifact olarak gösterilir. Yeni taban için yeni aday oluşturulur ve test/review tekrar çalışır. Böylece kaynak checkout hiçbir Graph çalışması sonucunda merge-conflict durumuna girmez.

## Uygulama sırası ve kabul ölçütleri

1. **RPC ve Windows izolasyon spike’ı.** Paketlenmiş OMP ile bir host aracını çağır, şemalı sonucu al, `session_settled` sonrasını doğrula ve iptal sırasında tüm süreç ağacının kapandığını göster. Worker’ın kaynak checkout’a, diğer run’a ve izin dışı araçlara erişmeye çalıştığı senaryoları dene. Bu kontroller geçmeden yazma ve test düğümlerini açma.
2. **Deterministik scheduler ve run deposu.** SQLite’ta graph planını, düğüm denemelerini ve artifact kimliklerini tut. Geçişi ve UI olay sıra numarasını aynı transaction’da yaz. Başarıyı ancak artifact kalıcı olduktan sonra kaydet. Restart sonrası eski denemeden gelen olayı reddet ve yarım denemeyi `interrupted` olarak kaydet. Başarılı düğümü yalnızca girdi kimlikleri değişmediyse yeniden kullan. Sahte executor ile bağımlılık, iptal, retry sınırı, stale sonuç ve restart davranışını doğrula.
3. **Uçtan uca MVP.** Önce `Planner → Context → Coder → Tester → Reviewer → Gate` akışını çalıştır. Desktop’ta ayrı Graph paneliyle planı, düğüm durumlarını, logları, hedefli retry’ı ve patch’i göster. Windows paket testinde normal sohbet açıkken Graph çalıştır. Başarı, hata, iptal ve yeniden başlatma senaryolarında kaynak dosyalarının, index’in ve refs’in değişmediğini doğrula. Export için hem başarılı test sonucu hem de kabul eden review aynı aday tree kimliğine bağlı olmalı.
4. **Paralel Coder.** Ortak dosya, lockfile, Windows case varyasyonu, kapsam dışı yazma ve eşzamanlı run senaryoları doğrulandıktan sonra aç. İlk gerçek senaryo JWT yenileme düzeltmesidir. Backend ve frontend ayrı kapsamda çalışır, paylaşılan API sözleşmesi gerekiyorsa tek bir düğüme atanır. Entegrasyon testi birleşik adayı bekler. Backend yeniden denendiğinde frontend düğümü yalnızca girdileri değişirse tekrar çalışır.

Teslimat kapısı, Graph değişikliklerinin `desktop/` ile sınırlı kalması ve paketlenmiş Desktop üzerinde hem normal sohbet hem Graph akışının doğrulanmasıdır. Bu sınır upstream ile ortak core dosyalarından kaynaklanan merge riskini ortadan kaldırır. Gelecekteki RPC uyumluluğu, desteklenen OMP sürümüyle yapılan başlangıç kontrolü ve paket smoke testiyle izlenir.

### Durum

| Adım | Durum | Commit |
| --- | --- | --- |
| 1. RPC ve Windows izolasyon spike’ı | Tamam. Worker, Docker tester ve sidecar probları geçiyor. | `cb7dbe27c7` |
| 2. Deterministik scheduler ve run deposu | Tamam. SQLite geçmişi, yeniden açma ve hedefli retry var. | `cb7dbe27c7`, `b70887c837` |
| 3. Uçtan uca MVP | Kısmen. Planner ve kullanıcı onayı, Coder → Tester → Reviewer → Gate akışı ve patch gösterimi çalışıyor. | `7dda121165` |
| 4. Paralel Coder | Tamam. Ayrık kapsamlı Coder’lar aynı anda çalışıyor. Ayrıntılar aşağıda. | `f9ab195125` |

3\. adımda kalanlar:
- Context Manager düğümü yok. Coder’lar onaylı dosyaları, sabit tabanı ve bağımlı oldukları görevlerin değişikliklerini okuyor.
- Desktop’ta log gösterimi yok.
- Kullanıcı planı Desktop’ta düzenleyemiyor. Yalnızca onaylayabiliyor veya atabiliyor.

Paketlenmiş Desktop’ta görsel kontrol yapıldı. Sahte model ve gerçek Docker kullanıldı. Plan önerisi, onay, bağımlı iki Coder, test, review ve patch adımları görüldü. Kontrol, açık Kostomp’un yanında ayrı bir WebView2 profiliyle açılan ikinci örnekte yapıldı. Aynı uygulamada sohbet akarken Graph çalıştırma senaryosu henüz doğrulanmadı.

## Faz 4: Paralel Coder

Faz tamamlandı. Aşağıdaki hazırlık ve kararlar uygulandı.

**Amaç:** Dosya kapsamları ayrık ve aralarında bağımlılık olmayan Coder görevleri aynı anda çalışsın. Onaylanan görev başına dosya sahipliği dispatch sözleşmesi olarak kalır. Test, review ve gate bütün Coder çıktılarını birleştiren tek aday üzerinde değişmeden çalışır.

**Sonuç:**
- `GraphRunStore.claimReady()` artık Coder’ları tek tek sıraya sokmuyor. Her dispatch’te yazma kapsamını kayıttaki görevlerden yeniden türetiyor ve yalnızca ayrık kapsamları birlikte alıyor. Görev kaydı olmayan eski run’larda Coder’lar yine tek tek çalışıyor.
- Workspace’in eşzamanlı yazmaları testle doğrulandı: aynı nesneleri aynı anda yazan sekiz yakalama ve birleştirme, tekrarlanabilir ağaçlar üretti.
- Sidecar hâlâ aynı anda tek run veya tek planlama işi kabul ediyor (`assertIdle()`).

**Uygulananlar:**
1. **Host’ta dispatch anı kontrolü:** Store, bir Coder’ı ancak dosya kapsamı çalışan diğer Coder’larınkiyle Windows anahtarları düzeyinde ayrıksa alır. Kapsam `run.context.tasks` kaydından yeniden türetilir. Planın daha önce doğrulanmış olmasına güvenilmez. Eski tek Coder’lı kayıtlar değişmeden çalışır.
2. **Eşzamanlılık sınırı:** `runApprovedGraph()` sabit 1 yerine `profile.json` içindeki isteğe bağlı `maxCoders` değeriyle çalışır. Değer 1–4 arasında bir tam sayıdır, verilmezse 2 kullanılır. Bu alan profil hash’ine yalnızca tanımlıysa girer. Böylece mevcut kayıtların hash’i değişmez ve retry’ları çalışmaya devam eder.
3. **Workspace eşzamanlılığı:** `captureChangeSet()` ve `compose()` her çağrıda ayrı bir private index kullanıyor. Aynı scratch nesne veritabanına eşzamanlı yazmanın güvenli olduğu testle doğrulandı.
4. **Worker profili:** Her deneme ayrı bir geçici `HOME` alır. `profile-home/.omp/agent` bu dizine kopyalanır, `TEMP` ve `TMP` de bu dizini gösterir. Deneme bitince dizin silinir. Kaynak profil yalnızca okunur. Paylaşılan dizinin eşzamanlı kullanımda güvenli olduğu doğrulanmadığı için kopya tercih edildi. Bunun bedeli, denemede yenilenen OAuth token’larının kaynak profile geri yazılmamasıdır. API anahtarlı profiller etkilenmez.
5. **İptal ve restart:** İptal, çalışan bütün Coder’ların süreç ağaçlarını kapatır. Restart sonrasında yarım kalan bütün denemeler `interrupted` olur.
6. **Planner rehberliği:** Lockfile, ortak şema ve üretilen dosyalar tek göreve atanır. Bu dosyalara ihtiyaç duyan diğer görevler o göreve bağımlı olur. Benzersiz sahiplik kuralı host’ta zaten uygulanıyor. Buradaki değişiklik yalnızca prompt’u kapsar.
7. **Desktop:** Dialog birden fazla çalışan Coder’ı gösterir. **Cancel** hepsini durdurur. Hedefli retry seçenekleri değişmez.

**Kabul senaryoları:**
- Sahte executor’daki bir bariyerle ayrık iki Coder’ın gerçekten çakışarak çalıştığı gösterilir. Bağımlı Coder, önkoşulu bitmeden başlamaz.
- Bir Coder başarısız olduğunda ayrık kardeşi tamamlanır. Test, başarısız Coder yüzünden bekler.
- Bir Coder kapsam dışına yazarsa yalnızca onun denemesi reddedilir.
- Dispatch anında Windows büyük/küçük harf varyantı ve dizin çakışması yeniden reddedilir.
- Backend yeniden denendiğinde frontend yalnızca girdileri değiştiyse tekrar çalışır. Aynı sonuç sonraki adımları tekrar çalıştırmaz.
- İki Coder çalışırken yapılan iptal ve restart, iki denemeyi de durdurur veya `interrupted` olarak kaydeder.
- Aktif run veya planlama varken ikinci onay ve ikinci planlama reddedilir. Eşzamanlı run desteği bu fazın kapsamı dışındadır.
- JWT yenileme senaryosu sahte modelle smoke probunda çalışır. Backend ve frontend ayrı görevlerdir, paylaşılan API sözleşmesi tek göreve aittir. Kaynak checkout, index ve refs değişmez.
- Paketlenmiş Desktop’ta iki Coder’ın aynı anda `running` göründüğü görsel olarak kontrol edilir.

**Kararlar:**
- Varsayılan paralel Coder sayısı 2’dir. Üst sınır 4’tür.
- Sınır `profile.json` içindeki isteğe bağlı `maxCoders` alanından ayarlanır. Desktop dialogunda bu ayar için bir alan olmaz.
- Her worker denemesi profilin kendine ait geçici bir kopyasını kullanır.
- Sidecar aynı anda tek run veya tek planlama işi çalıştırır. Eşzamanlı run’lar ayrı bir fazdır.
