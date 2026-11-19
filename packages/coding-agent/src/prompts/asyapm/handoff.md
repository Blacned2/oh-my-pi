AsyaPM görevi **{{key}}**: {{summary}}
{{#if instruction}}

## Talimat
{{instruction}}
{{/if}}

## Bilgiler
- Organizasyon: {{org}} · issue_id: {{id}}
- Tip: {{type}} · Durum: {{status}}{{#if priority}} · Öncelik: {{priority}}{{/if}}
- Raporlayan: {{#if reporter}}{{reporter}}{{else}}-{{/if}} · Atanan: {{#if assignee}}{{assignee}}{{else}}atanmamış{{/if}}
{{#if labels}}
- Etiketler: {{labels}}
{{/if}}
- Bağlantı: {{webUrl}}

## Açıklama
{{#if description}}{{description}}{{else}}(açıklama yok){{/if}}
{{#if comments.length}}

## Yorumlar ({{comments.length}})
{{#each comments}}

**{{author}}** · {{date}} UTC{{#if internal}} · dahili{{/if}}
{{#if body}}{{body}}{{else}}(boş){{/if}}
{{/each}}
{{/if}}
{{#if imageCount}}

{{imageCount}} görsel ekli; metindeki [Görsel N], mesajın N. ekidir.
{{/if}}
{{#if note}}

## Proje notu
{{note}}
{{/if}}

## Çalışma şekli
1. Görevi, yorumları ve görselleri incele; ilgili kodu bu çalışma klasöründe bul.
2. Kök nedeni kısaca açıkla; sonra düzelt ve doğrula.
3. Gereksinim belirsizse ya da değişiklik görevin kapsamını aşıyorsa önce sor.
4. Bitince neyi değiştirdiğini ve nasıl doğruladığını özetle.

AsyaPM'de durum değiştirme ya da yorum ekleme yalnızca istenirse: `asyapm` aracı, org `{{org}}`, issue_id {{id}}.
{{#if instruction}}

Talimat bu adımlarla çelişirse talimat geçerlidir.
{{/if}}
