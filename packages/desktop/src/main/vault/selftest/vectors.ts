// Known-answer vectors for the power-up self-test (audit §5.2, C6). Computed with node:crypto and hash-wasm,
// independently of @slate/native, and recomputed by vectors.test.ts; the PBKDF2 and Argon2id outputs are the
// audit's Appendix A vectors.
//
// The module imports no key bytes (review C2 M3), so the self-test brings known keys in the way the vault
// formats do: a password-class KEK from a public secret (`kbkdfFromSecret`) unwraps a public master key, and
// the production key schedule (`deriveSubkey`) derives every other key from it. Those keys are public by
// construction and live only for the run; post.ts destroys each one (POST-ZEROIZE).

const hex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'hex'))
const fill = (n: number, byte: number): Uint8Array => new Uint8Array(n).fill(byte)
const seq = (n: number, from = 0): Uint8Array => Uint8Array.from({ length: n }, (_, i) => from + i)
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

/** The vault id whose 16 bytes are every suite-0x02 KBKDF Context below (the audit's KBKDF context). */
export const KAT_VAULT_ID = '00000000-0000-4000-8000-0000000000aa'

export const KAT = {
  /** KEK_t = KBKDF(00..1f, "slate/post/transport", vid), password class; MK = 20..3f wrapped under it. */
  transport: {
    /** A fresh copy each time: the module wipes the secret it is given. */
    secret: () => seq(32),
    label: 'slate/post/transport',
    mkIv: fill(12, 0x33),
    mkAad: utf8('slate/post/mk'),
    mkWrap: hex('3388ca613e7a1e4f6ced2cbe5213e00721158305ca90e734cbc41764991e3018a7ad97c2071cfa7ef44adc7c099cc9c2'),
  },
  sha256: { msg: utf8('abc'), out: hex('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') }, // FIPS 180-4 example
  /** blobRemoteName(K_name v2, "post.png") = HMAC-SHA-256(K_name, "blob|post.png"). */
  hmacSha256: { name: 'post.png', out: 'a9ad6e71c62af744727f94e603e2ce853b8022718c189fc7e9197baa0a8401bc' },
  /** encodeId(K_name_enc v1, page, uuid): one AES-256 block of the packed id (suite 0x01 names). */
  aesEcb: { kind: 'page', uuid: '00000000-0000-4000-8000-000000000001', name: 'ac694c0a827f33870c991f75990b8329' },
  /** Under K_prefs v2: AES-256-CTR from a fixed counter block, and GCM with a fixed IV (opened, never sealed). */
  aesGcm: {
    pt: utf8('slate-post-gcm-plaintext'),
    icb: fill(16, 0x44),
    ctr: hex('74309c301f73f45ea25c8360a11e79ae93908cd00f3cf2f3'),
    iv: fill(12, 0x55),
    aad: utf8('slate/post/gcm'),
    ctTag: hex('6174e761724ed51af69dfd7ed5190b8e759b47ddd7a65e935cb43e11608b33bccc4f4766d1009aa2'),
  },
  /** HMAC-SHA-256(subkey, probe) for K_sync of each key schedule: KBKDF (suite 0x02) and RFC 5869 HKDF (0x01). */
  probe: utf8('slate/post/probe'),
  kbkdf: { out: hex('40b25650f41b008b3e18d6f659cf56b5d461dcaab389c1fc02cc982682533e32') },
  hkdfV1: { out: hex('319545a810b8d3659c4c118ee0296f2040e02fb5931298f0af3302e3095fa324') },
  /**
   * Password KEKs, each checked by unwrapping 40..5f sealed under the expected KEK (Appendix A outputs). The
   * inputs are fixed in kdf.ts (`selfTestKek`), so nothing can ask it for another derivation; vectors.test.ts
   * holds them equal to these.
   */
  kdfWrap: { iv: fill(12, 0x66), aad: utf8('slate/post/kdf') },
  pbkdf2: {
    password: 'slate-kat-password',
    salt: fill(32, 0x5a),
    iterations: 1000,
    out: hex('13aaaff0d5b53fa8de2272037363cf3797267e3b583f4127e55a47cf2feb2079'),
    wrap: hex('ec11d124a6e74830691b7f8c88d41f3893d18b377690a348a44a90fd1830a743978d088452d234b80c549aed59b9f818'),
  },
  argon2: {
    password: 'slate-kat-password',
    salt: fill(16, 0x5a),
    memoryKiB: 32,
    passes: 3,
    out: hex('688b4d6d818d74c8ffa75d1f2439b2ddb829d1ae84814d54944b9740d4909812'),
    wrap: hex('5385c97a5e853dfa95b2c4d9c0f8aeacccc784c28fbf7d5e1db52db6c4e7f7e9da163159e1ae88dd5e9b7b27759ed1b9'),
  },
  /** POST-KEY-WRAP: a second password-class KEK, KBKDF(a0..bf, "slate/post/transport", vid), and the wraps' AAD. */
  keyWrap: { secret2: () => seq(32, 0xa0), aad: utf8('slate/post/wrap') },
  /** POST-RECOVERY: the recovery key 80..9f as typed text, and MK sealed under its KEK_rc = KBKDF(rk, "slate/v2/recovery", vid). */
  recovery: {
    text: 'G20R-50W4-GP38-F249-HA5R-S3CE-HY89-34MK-JJAS-D5WR-K6D9-Q74X-KTFG-GBC6',
    iv: fill(12, 0x77),
    aad: utf8('slate/post/recovery'),
    wrap: hex('41b6e0725d02b0241bc6848e90b84782e720ae39b6be21f0806a138ab09b7088d6f737bb11e501e25f8f196559743a2a'),
  },
  /** Envelopes under K_sync of each schedule, salt 11 x 16, nonce 22 x 12, epoch 0, no flags. */
  envelope: {
    path: 'docs/page_00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/00000001.chunk',
    plaintext: utf8('slate-kat-plaintext'),
    sle2: hex('534c453202000000000011111111111111111111111111111111222222222222222222222222fdd9ade163a688b97af8cb8c8a466cca26bf3c9a4ceb0042a96469dba7dd481f24fa85'),
    sle1: hex('534c45310011111111111111111111111111111111222222222222222222222222c84c42456e94bf248e150675453fea5bb0c936b75ed7aee75f905cada9a486659ff77e'),
  },
  /** encodeIdV2(K_name_enc v2, K_name_mac v2, page, uuid): the suite-0x02 SIV name. */
  nameV2: { kind: 'page', uuid: '00000000-0000-4000-8000-000000000001', name: '79562cdb0c97e0e24e5f707d6c96f07c35f98b83f461f73656af0db679a7078d' },
  /**
   * POST-MLDSA-VERIFY (PQ-A4): ML-DSA-65 pure verification with a context string, outside the FIPS boundary. The pass
   * vector is ACVP ML-DSA-sigVer-FIPS204 tcId 43 (packages/native/test/vectors/mldsa/sigver.h; vectors.test.ts holds
   * them equal), `spki` its public key in RFC 9881 SubjectPublicKeyInfo form. The fail vector is that signature with
   * one bit of its first byte flipped, built in post.ts, which must verify as false.
   */
  mldsa65: {
    spki: hex(
      '308207b2300b0609608648016503040312038207a1008cb1f70b1674c4c78c4649218a87c34de9dd3e9f9130c4d7594e7edc' +
      '92258ffef109bb0478dbb80612c0dff30a8bf26b6e5f9faf0b82c62354d2fa9a6772a272f4574a9ea2c3a60c5895ff9e2a1c' +
      'ea2afac56038492ac373aff33c8c85b4627c438043e3d9a7f9cf0e373a5dc10c24e4e8f6d870fc4763261430f645ff5dc064' +
      '7b651a0bda2a0ccba91809781101454d5ee841fac5daa25195d9542d97b5df3b4b82256763f16049f2fcd77549c776eb9bb6' +
      'e3e07a2d42f710caba04309a0f749ef7d7161061d84de94e5d75bbc9fc5909079d44814d26cfbb0a7b253fd6a9d4ec3fa34c' +
      'eadba4e27a3a7ee9c24427751e2b200fcd5496b3de10d1ca2f3dc1efe5d7faa1535bf9d3862480eb06eac16ab25ba9fb0b2c' +
      'a114ec00da51b295520e2c6675ad2a008b3ece78da59a373accafb5fcc63106bacdda7a228c7217d5c64241c79d1707536e0' +
      '14e568df766b8e6fd0625b4bc498dc5106c2be1399c56521cd317a7120848bae8c87989c7137e2ce42cd7f87a93495b61bdd' +
      '30c066406fc17b4e653024c2c8e5509d48260a3dee501a10d52251aa84ae9b43577c65e630941ceac380996611f746f7d3db' +
      '467b53c39afdcecebc527ee3d8177fac712d7cf63f19677b4175bdb1d587132757bbc6c605c1d8d960e15d1b930119c77b88' +
      'e3af97966be57460adecf5b62ffdd80e700265456c26e61798bf1aadc9b4e9f57e3e2bb86f8ef652a98d416cd0ff637e1615' +
      'e86078da23500ec6c0593383c279260996df83a99ebf018aa8b55adca2e4545df37f55c58fda23008201a0758dae4a92c146' +
      '2abd6fdd32feae7cb89d53c2b6bc5bd90d41bbbecd839907bc85b3e120d292b4ba8f43c3090d6db14a980c5b829aeb6afed7' +
      '0ba32e9159f83cc8d6c2aac1bb2cc781d7c085ccf5035dc9ba04e5e1c8741cc80e04da0e1b43848909ed68fb03a414a8fb5f' +
      '19af05ac5dd72d7ef0456e929b2ad70fcd718563f25cea88ac733a1ab0ecaf286ee1f6dd43da5ca6da784eb648c0b2f68e2f' +
      '0884460ef3c13457af80b6e999a9f5dd32e2cb95445ccd3a5180851ce9620d44b8a49c50fcead332aefc9998ccb4ac88ac3f' +
      '84fdbfc29f53442587542df0174bd563dfa6b5e3b050831e0643b68de861b7cc4273aee0bfd938d4df3675de075a40fb760e' +
      '480c7516ce6695fd4496b6b2fd6314f9dff15e05a8414c3a3ceb0fc132270913489006512940b563eff1c2a2e1ac7a92256d' +
      '647e3f9b4aeec68ea9516b4a2f2a9973f7ce2f29f2bfadf13c4f3c8de7a28d7a7f51b5ec988ed29b2a5cbad60f25c6af20be' +
      'd04938ce7fbaa0eb35010abde22a1e2227b216b0b9c98fcb3646783a76efd584a4419ffb982d97e9de88540e8880af98366a' +
      '4ee062c16ed195829752ec014b6f11a4633dd712d87e782268ab6e0f4f7ad197d57607ab9e6c6c4348b25d737eb9944295fa' +
      'c92787ba3b1e85bf9264c2433129084b622528e06e82bf6e02c8b9e9436b33ad56ee80056890a78846dba038a6e518a59120' +
      '2672926f35026ef941c048a71d87547817734caac02a6bc420f922bba45d710c9195d6cba430a7eb7d02e26cd79dbc78660d' +
      'c5d1344fa26657125db5a7688b3012f8258300ec811777cfd5f7bc3c8a332ad9ebb351300633be668b00b32d2390c610d8d8' +
      '030f23ee50f2f733875c3ed227699fe89e880782af7260275208ad6235561ea04fbaccb7584bd34f49a6ee9c1acf92d27eb9' +
      '7bb4f01f1d6d9220cde17c0d8c2cb4010eac33597483d26dcbd1947d7a2db792dee31ce27489a1d7c95e6b7096abcccdb610' +
      'f0ab800ba9c6389ec1c830a3e4c2c18a89439fb7579d3282a5e7462308c858c4cae7bc8a3eadd661221db4b135d09ddcf4a2' +
      'b165d46147b810cc28a1c578f80345d2533e4b87d4e3cc892ac5b420b9442104522acad59fcff8a245312a4d1831148ad51a' +
      '82e161be99855bf97a0ffb9b729864ac3d1633813d4008f772b881aa2b67aa1fccc5854c94bf6fc8622542e32bdc64fba363' +
      '9e55a2261f5afe0720fc6c44f5431bf766e0a7b56303f91fd98e4dde3ee1226840297e6fc9c013e28be72c182e8ad0bb226b' +
      '73aac8c4eb49727af1355f3236b3aed732010074df6e79e99436dc3af9d578d7e8a5353a6a9511f602738ba0c0069304cfe6' +
      '54b72c38d0593f6ca2dfb29d12bcb2935378de6d0fb5f3e10947cf5eb7047d0c92aba8445374ff35eed92fb33eec983837b8' +
      '3d666e6b94902cdd00747bb467e69418019ddca3eec516a69523641d33d97abe3f3d2d4a17bc52a9bfdd7cccdc156300388a' +
      '35d51c5a0d3fa7840a7f3cac1ff4460dd899f58a5d4ba6a965c637d8ebdc04027917b2a30f6b766ae6adc574eb738d49628f' +
      'df48d3f53d11bd15871127249c7d43058ad6c4e31f22dcbb56f267681522ddc96f2bca0eebe41b62eee59f48bb5c6c739d27' +
      '76c574dff0bb152d5c42025efa51e610f339a70772ca687726719cd9aa9fef26aded3ed2ac52e291aa28309d9446933305b6' +
      '9b3560f7fecada31872e4ea93b9499d05ad53bde53d195a18d1d7a9e2b99539ea3bba1ec7ad9bcfc93e97cddf4ca392bf29e' +
      '4278a814c922adbc884869b8b02b017dc3161aec94fd33b5bb4c6900f88e791a02f898aaa7bfcffc729974a3ea3e167bf7ce' +
      '7281353ebdff01f59686a4a8fab8d03b67a3d791f3f12660fe45faa33dd345c040081f6903f1f91fe836440d0f7f3b03e1ce' +
      '47ed3505cf6e278bbe17ad5b94a974f24b5fa6c4357f3e27',
    ),
    msg: hex('3a5103959f0daf780cfdcde33a4de0b67f988a8deaff5153bd8d029cf0a7ddc680aea1938b951d5472652e0fa5c67a45c8a9ae3bb3eddbdce58e2bbd6221de3a0d73aab593a9602ed33e7ac6db37e2e94a64becfe2ea3a2a63353debc4f092ec2b0a4687afc4aa87789025ed183f11237af0aef50e094454fa59793e30d9bff82b9205ed5a5cd9f85accd8263f3484dd736ec584e9be7f30f7a1e488bd055351b764229c1c85'),
    ctx: hex('339a8d7a51fc155e69fd1dc3feb136a98775c4008cb767f66e04b5732c2332b04b2f4e4a991b702606fc8c60c07145bc0b183f5040979182e42795c2221c5bf55ede34436d42c2c6c605981e3a4c1d04c7d78f8719918e8073bc8c5be2372b9e1ac7adde760d949ba058e2ce18053f718278fa4eba76bc0cbcaa5102de621fa8d3b02379be9f7dc2264afed69d4b2bc4be6abd02e0'),
    sig: hex(
      '9ad1b65bbfc23890e45aafa15b7840a7bac0c210236e05dc48d7e8c02deba4a2f3862d836baedb255df88caafaf170a7dd50' +
      '7e9f5af5bd10784f0bddfd8cc9749d4521c47fb119c002c0cbd4ea8469655fab33d664d12efc964ea34055c4d2c2b7f61eb5' +
      'b2f3ecb2fe8de5ee88cd22428c0eff3b23582636d0e5860528682fa0b953c6e304c344a3064d44f5b7277e4ff9fa4d1db547' +
      '6a422a3abf88cea5ff96cb67497254203d6146f69c449bb1a0e0dc97ae044aaef67b1c0aa5b6547204c7dba6b8f05f359949' +
      '060a32a965159bc29ea61503e0ba0aab638781f148c5ee096c991cccc0b0f27f2ffad1d9ebf7719b77a39696409de29d8eec' +
      'b109ad6b727c01cbaf7f24297faf0152eb0dd5fd60c246ad63dc1171b45b2128a2103a98a56b0b94593350cda5fdbf22f24b' +
      '2f7b80b18bae6f87e0a404d7dda7e9bd97e5e6f949fbca911666d806f2601ef9ddff87ce418fa2e731e8e8d3fd00ebee75a4' +
      'a1ddc0236405f451fed0abc1909f782821f561cbbafe08e9331d7585430ef84e7c43051373f81daa6fd6b54090e3e6792776' +
      '32a5a62669e5d5ab88d58c5372fb0b4420953f4a6ad34265f5615c2068ffba1a81910267ac00ad00f30c3250a20b85ebe54e' +
      'b7af2175f20e5acb1dde2e943d440737ec25b7f2a6f4ba8d61c6b476b48151203cc13e4896070c94b14e52262dfc010637cb' +
      '74d3a840d6a9bda04c1c4a888f2950ad4edfff30525aca3b9f10f9b983e39a4bf6ca873fbe65fa72e67e1371e2cc6f7eeaeb' +
      'dd7132c222c6f4243d85c605de8071e862bbbbfbe8258e34b393d17eef3142be3ecd5932b1d84b65d84d1ee3fdbf771c1c09' +
      'f0df12e33ab6e7c95b5788d97369f6db3c3f48e11fa46eab39e5b1583afca0fa574532924356e17b7b5ec0e49c176305a86b' +
      '1c6fe1eb4ec78240c75a30ba658a69959c85d36b0b852ec529a602c99e75450478662c25f60afd4fb7bc8a24c442c4da5bd2' +
      'cd9ec11b11a35cdd4bdc545df0ad49e03d7bebd4fb99ac984f830a679784905a6e51967e6c4575f3555519448b572391e06b' +
      '1aa3e28f92d31741aad0062130bd579206969a1f9afbe39abe6e0c1a9adfdb056260f2a5a700064dc248d8a10fc04918d717' +
      '14e892d4176a0c399072b142d0936763eb4ee19f2ab05f88936b818b5caced5a237d65e2e1c0c7b498e2fcc7775496571580' +
      '4c7afc2744e1e54a95cce2f06e7f8301ede648be97d7a115248bde0f7bbeb8eaa69a3b4e96b0a508f68da84a8cc152572770' +
      '21c97208fa30a0d278b28f94058d13146231d11c9c179ed4b893e3d1981cb6fa21ee5d3fda59cdadd92a171df7a42a6d3d7a' +
      '24d1a78a43b2c9bac2d201f0680387aa7b8303cd9e1c7b4925d08309c2732e6e23e139ab402a3787b77c15637228f056b73f' +
      'd18e16009e58cee02cca45481f39a5d84baaec0a3ef7d30d6a44bd5dd2b0ece2733c8902ecfc675c009829c67e5676d306e4' +
      'ecae4ac48aaea2cad8ec067185f3b0f33304c36f04c1896bd64a81b36d3f7610ceaed4b222bd24f90939e3be183912d4d15d' +
      '1b5c9e112566872765a8edf10de6b77f4fe7e2ae85012f7ecc560bf42eec11bfba0e45d90c1bfed3b3173e27aa134fd31d42' +
      'fca2b6617d553ae2b247c8c104f436d3891bf22c709ac86cf9ae3a2d5a1ffdb84e5a71ac487f8cc4ab1df47a277c96273d8a' +
      'bef63a545e702a82771d056a89c844b66e16f867364a928b1e23f1aa98f8adc60f3e734f62a1634fb0266ea6944c98e566d9' +
      '7438e25de752f8f9abd8c1d515a11407d6a04ceaf5f1f7dc0b94ff9def1fd17c6e19565599274a5cf5262357fca3e635bcfd' +
      '22c69ee7e0c5b332925b5f53ef5002d4fa784af15c3cfb9b667b7ea866057c59542c1c87f015fda467085e4e2d370f8eb6bc' +
      '6c8e1cf232c2c8e6d30d0f9439ae0599fa35e9e0a0ed93d90562bfa12da126a10c908a1fc0f11c92de77b73a11577996d061' +
      '532bdbec8d8a87a1f82409e2b2db621347b5ec3ecf1f166bf3df24244c039bf7671487e419e1098baaa547a4e38790fd82a0' +
      '5db088ce757b5eb800ed709d1e3a88303d8079b6e0bebf8cdb6317c7a62c944bff7c2a62bb69639c9c2c4223a599ea4e69cb' +
      '6a7e859285f827d602bc0d0d67120a60f8b79124a41dec362d8c7a54dabfb35d2a54a870f72d9544fd9f267608487630c273' +
      '512e59e2cc4998c677e74e2c33075aa4def12189c75360a7a24ff9d9be2a4ba1632f5b3258701f6ac1d22adb26c0111c7f5d' +
      '4381d0a5b2f60ea699a3fd7851063aa77738a4b9819cbde62cab864ed918fcc7330730061aa84326ca6d39053fdf1650a5fd' +
      '7bf4ae64f6e4990b725cae8f7f92c19c56d0af94f81777db4fec3c6daad2dfec848557897940403ad6f914a34264e959523a' +
      'b1a3a444ffcaa79a292568e438b94545f0fb1ffaca6ae95ff155d23dc97fa3ee0eed1dd3fdd8792a86ce7c7f8289d288b792' +
      'c32e88b7c61ab50868e0cd35a1811d04fcc61c479f5489616317cdf87632e9dce435dd3fd46895d16791502ef470a5e1adb9' +
      '0d9e20e190f3a527bbbc4a104a48de28d5b208c5257c943150cf550c36c5fa6e3478946e2c90a2bf916bf8d2ce7edf6f349a' +
      '38d02aaa5e36149fe6dd155a8747c94d44c499c5b57173079fc8cc10db8bad0863dff99cc13f7bc5a65c4d27740876fff2ef' +
      'bbdd1f253fe3b468dc2a5a489c9cea645679fe26571793f042fca9c9435d88638fc4270de60fe127f9f6fadff489b281cae6' +
      'fd1fa8ba4f24aaa05bc262a67ddc192c783423e4a412592f2f0cbf4f03a0471605bda6894d19d61e47419525c5437b0bed40' +
      '69bd135c30c8f2049624322c1db4db6f54e1cc7a927e0dd4e97b1a6c29e4c7a76c8aaa951bb6e41744c1fd5352a5962561f9' +
      'b63b64a7b1675487b2a6c45496248ddcb4bbf03ec6a202bfaefbfb32f04aab5865c88e0684d36b2efa97ea96cb94ef7fc0e6' +
      'fec03968d1f2ac5496425fc93ac3e1dfc47b705c247efcb5605bdd8e05cbeb11e3cda098b691f8e71112dd5ed7d84c3e026d' +
      'dfaa9627dab526ed6b5f55f798f578b8c5f6b946f61f116235892ca2b093edf97da23266497d3fa3c62268579074bc1cc8b8' +
      'f7b13bd9fef435f04be972bb84f4017e758971eb9bda1268c56a46a302f4bb3465a1077a036a3c3106bacd9f4bc7ef1177d0' +
      '34051d2e5da766ab8c41838bf6b31208034e56866dd8afcfc65b8eade35743b22c7dcd787eb0abc77d912b7fb0c9ca2511ff' +
      'fae45f999b8380b1179a1f18a0ce9e19b6eae7ac8d7d78fe9f41ef8db39ccfc23a4c1da7192a0cfe7bb916fbe1cccbe1ecf3' +
      '6ffafc81217f803e5b7b33f1c0649018cc3c22099f325338255b718fb850f7718a330cfb2eb4b14ea990388c9c8e9c9b62a6' +
      '62ac6a312f8d2bacbefc032364597bed9f0ae145144a0804f2bf18694118b7af7e159f9e7ad22b1b21826e3caf679db9b0ac' +
      '72b6b4eb50fe43bb059282d30cead670f999d3c01f1fcac03ca770030838a2cec064662c6c53d10c60118fe0a74b23618bfb' +
      '98fcf227e1711d80fbdc057111e6e3203f53cb043b2994d90f732000f440b2da5e7c65c2c10738f534f55562de16a03df2f2' +
      '909e57078ab102a5f6164b8b6f4397abb52f225d3221287c40a1eb4067656a79006a2a9d0dc64a29d0e7896fe33de94c261b' +
      'd14696f1b33ff19b22bc2c1f9032636d323d8b8753f04f0dd099da0b312c65a7da81d66656862286df205dd82439b0b63cf3' +
      '87e95c94ebfc406e5c37cffcc85a930def8eb9770ab7c62cad7e58fddb00b70d888e9b8a78f0372509f221154d4c2d46fbb3' +
      '521b98126f76ac171dd5f71e96c64318c622ec21916474f49be1cc3c3340651839f77c4a54e007c4e82b0b132c734ce135d5' +
      '5c3ae9c5170a5545d3b03e524323e73e4d15dcc55a7148a425de6f081e0f3de9a01aec6a1b2f1079a43cd22f483592d2875b' +
      'a050d9e1708bd0aa1aec0b71438712b4b457df2358401cc3d7bcfdbbf4216284b79565040557d5a65721cf8dc364e8796add' +
      '73c2ac0e6633c602370bfe8ffc54ae666d64ec2301ed0c50a0ee61cfe27b34ef1b8ea605e29ea6ee1f63483fb8f37bc4085a' +
      'b2b28cfc6317b16b470a33445b07d76a4a53649763afa18ce001985511cf0607474a9c52067eecb96d8a55adb5ee47ec76a8' +
      'e6fe3ff4574736a14cf66c2607e14c84dd28ceb2f5d6269a58f03a037ec3295ca0f996f907c8c6da0e0ef45839890f81127c' +
      'e5e1917b2989318f7b647946e99238f1bfc7dcf531fda497288d126efcdf3bb84f247f6118c1cfb272c0630e7518acdbc660' +
      'aad8b9412d43fa46a7f63f43dacfbdbb3ec0357f249da55df67ccc0f09a3df460e604e1f03ea55ccc3ebd3b6b766ec7d3367' +
      '34e488ed55b104f517f5616ae1fd8437c225cfb68167314e0d0258daf0ddb993581cb1ca94332a97bc0f564a5254699ea92d' +
      'da1f1b7b17bcd9a64ca4c5a1619f541f40583aa07f522b88fe81c40252d87cfaa6a9ddb666185d1c571b1bd161b6979a47b3' +
      '447c795a7abb75d7631e4cddbde300f19b684f7c21ad25457841b0f672fbc5a9d816d0e6fc51eae6816d3c2b8fe2fdc73f62' +
      'c7d1dbe91e2b51546ca9b8ca304453777a8791a6071b2f313a52eaeff1090a0f374650576c8bafe2f71c6e8a9e0000000000' +
      '000000060e161f2b2f',
    ),
  },
} as const
