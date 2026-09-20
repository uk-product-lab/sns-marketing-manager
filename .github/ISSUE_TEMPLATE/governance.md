---
name: ガバナンス変更
about: Harness、workflow、Skills、検証器、意思決定記録の専用変更
title: "[GOVERNANCE] "
labels: "type:governance,status:proposed"
assignees: ""
---

## 変更理由

## 対象となる保護ファイル

## 製品コードを含まないこと

- [ ] 製品コード、機能、DB変更を混在させない

## 変更前に防いでいた迂回

## 変更後も維持する安全条件

## 検証方法

## 戻し方

## 独立監査

- Auditor Session:
- Result: 未実施 | DOCS_PASS | HARNESS_LOCAL_PASS | FAIL | BLOCKED
- Evidence:

`DOCS_PASS`と`HARNESS_LOCAL_PASS`は固定SHAの文書・ローカル検証だけを表し、製品E2E、実GitHub設定、マージ可能性を証明しない。

## 取締役会決定

- Decision ID:
- Board representative approval: 未承認 | 承認

承認後、唯一のOrganization owner兼board reviewerである`ukyo-0001`本人が内容を確認し、PRへ`governance:approved`を付ける。実装エージェントはこのラベルを付けない。同じloginの照合だけを本人性の証明とはしない。
